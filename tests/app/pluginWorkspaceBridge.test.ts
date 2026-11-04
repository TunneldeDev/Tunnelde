import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host, PluginInfo, SshSession } from "@/lib/api/types";
import {
  pluginWorkspaceSnapshot,
  runPluginWorkspaceRequest,
  wirePluginWorkspaceBridge,
  reconcilePluginWorkspace,
  type PluginWorkspaceRequest,
} from "@/app/pluginWorkspaceBridge";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { useQuickAccess } from "@/store/quickAccess";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  hostsSnapshot: vi.fn(),
  sshSessions: vi.fn(),
  toast: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  cleanups: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, isTauri: () => true }));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/i18n/i18n", () => ({
  default: { t: (key: string, params?: { name?: string }) => `${key}${params?.name ?? ""}` },
}));

const host = { id: "host-one", name: "Production", host: "example.com" } as Host;
const session = {
  id: "session-one",
  hostId: host.id,
  title: "Production SSH",
} as SshSession;
const request = (method: string, params: Record<string, unknown> = {}): PluginWorkspaceRequest => ({
  requestId: "request-one",
  pluginId: "example.tool",
  method,
  params,
});
const emit = (event: string, payload: unknown) => mocks.handlers.get(event)?.({ payload });
const settle = async () => {
  for (let count = 0; count < 10; count++) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.hostsSnapshot.mockReset().mockResolvedValue({ hosts: [host], groups: [] });
  mocks.sshSessions.mockReset().mockResolvedValue([session]);
  mocks.toast.mockReset();
  mocks.handlers.clear();
  mocks.cleanups.length = 0;
  mocks.listen.mockReset().mockImplementation(async (name, handler) => {
    mocks.handlers.set(name, handler);
    const unlisten = vi.fn(() => mocks.handlers.delete(name));
    mocks.cleanups.push(unlisten);
    return unlisten;
  });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
  useHosts.setState({ hosts: [], groups: [], loaded: false });
  useSsh.setState({ sessions: [] });
  useEditors.setState({ entries: {} });
  useDialogs.getState().close();
  usePlugins.setState({ items: [{ id: "example.tool", name: "Installed tool" } as PluginInfo] });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  useDialogs.getState().close();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("plugin workspace bridge authorization and live state", () => {
  it("reconciles host titles and invalidates local and remote views after event recovery", async () => {
    useWorkspace.getState().openHost(host);
    mocks.hostsSnapshot.mockResolvedValue({
      hosts: [{ ...host, name: "Recovered name" }],
      groups: [],
    });
    const files = vi.fn(),
      history = vi.fn();
    const lifetime = new AbortController();
    window.addEventListener("tunnelde:files-changed", files, { signal: lifetime.signal });
    window.addEventListener("tunnelde:history-changed", history, { signal: lifetime.signal });
    try {
      await reconcilePluginWorkspace(lifetime.signal);
      expect(useWorkspace.getState().tabs[0]?.title).toBe("Recovered name");
      expect(files.mock.calls.map(([event]) => event.detail.source)).toEqual([
        { kind: "local" },
        { kind: "remote", sessionId: session.id },
      ]);
      expect(history).toHaveBeenCalledOnce();
    } finally {
      lifetime.abort();
    }
  });

  it("opens a query without executing it and applies pane locks idempotently", async () => {
    await runPluginWorkspaceRequest(request("workspace.showQuickAccess", { query: "> UUID" }));
    expect(useQuickAccess.getState().query).toBe("> UUID");
    expect(useWorkspace.getState().tabs).toEqual([]);
    for (let i = 0; i < 2; i++)
      await runPluginWorkspaceRequest(
        request("workspace.setPaneLocked", { paneId: "pane-1", locked: true }),
      );
    expect(useWorkspace.getState().panes[0]?.locked).toBe(true);
    await expect(
      runPluginWorkspaceRequest(
        request("workspace.resizeSplit", { splitId: "missing", ratio: 0.4 }),
      ),
    ).rejects.toThrow("split.notFound");
    await expect(
      runPluginWorkspaceRequest(
        request("workspace.resizeSplit", { splitId: "missing", ratio: Number.NaN }),
      ),
    ).rejects.toThrow("invalid:ratio");
  });
  it("does not mutate the workspace when backend authorization fails", async () => {
    mocks.invoke.mockRejectedValue(new Error("permissionDenied"));
    await expect(
      runPluginWorkspaceRequest(request("workspace.openPage", { kind: "settings" })),
    ).rejects.toThrow("permissionDenied");
    expect(useWorkspace.getState().tabs).toEqual([]);
  });

  it("reads current pane state after opening, splitting and moving tabs", async () => {
    await runPluginWorkspaceRequest(request("workspace.openPage", { kind: "settings" }));
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === "page:settings")?.preview).toBe(
      false,
    );
    useWorkspace.getState().openPage("about");
    await runPluginWorkspaceRequest(
      request("workspace.split", {
        tabId: "page:about",
        direction: "column",
        position: "before",
        targetPaneId: "pane-1",
      }),
    );
    expect(pluginWorkspaceSnapshot().panes).toHaveLength(2);
    await runPluginWorkspaceRequest(
      request("workspace.move", {
        tabId: "page:about",
        paneId: "pane-1",
        beforeTabId: "page:settings",
      }),
    );
    expect(pluginWorkspaceSnapshot().panes[0]?.tabIds).toEqual(["page:about", "page:settings"]);
    const result = await runPluginWorkspaceRequest(request("workspace.snapshot"));
    expect(result).toEqual(pluginWorkspaceSnapshot());
    expect(mocks.hostsSnapshot).not.toHaveBeenCalled();
  });

  it("validates page, sidebar, tab and pane targets before mutations", async () => {
    useWorkspace.getState().openPage("about");
    const before = pluginWorkspaceSnapshot();
    for (const [method, params] of [
      ["workspace.openPage", { kind: "vault" }],
      ["workspace.openSidebar", { view: "missing" }],
      ["workspace.activate", { tabId: "missing" }],
      ["workspace.split", { tabId: "page:about", direction: "row", targetPaneId: "missing" }],
      ["workspace.move", { tabId: "page:about", paneId: "pane-1", beforeTabId: "missing" }],
      ["invoke", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(runPluginWorkspaceRequest(request(method, params))).rejects.toThrow();
    }
    expect(pluginWorkspaceSnapshot()).toEqual(before);
  });

  it("checks authorization again after loading host metadata", async () => {
    const pending = deferred<{ hosts: Host[]; groups: [] }>();
    mocks.hostsSnapshot.mockReturnValue(pending.promise);
    const operation = runPluginWorkspaceRequest(request("workspace.openHost", { hostId: host.id }));
    await settle();
    mocks.invoke.mockRejectedValue(new Error("runtimeRevoked"));
    pending.resolve({ hosts: [host], groups: [] });
    await expect(operation).rejects.toThrow("runtimeRevoked");
    expect(useWorkspace.getState().tabs).toEqual([]);
    expect(useHosts.getState().hosts).toEqual([]);
  });

  it("opens only real connected sessions and rechecks access after the session lookup", async () => {
    await runPluginWorkspaceRequest(request("workspace.openTerminal", { sessionId: session.id }));
    expect(useWorkspace.getState().tabs[0]?.id).toBe(`terminal:${session.id}`);
    expect(useSsh.getState().sessions).toEqual([session]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await expect(
      runPluginWorkspaceRequest(request("workspace.openFiles", { sessionId: "missing" })),
    ).rejects.toThrow("ssh.sessionMissing");
  });

  it("preserves the normal unsaved editor confirmation when a plugin closes a tab", async () => {
    const tabId = "editor:session-one:/file.txt";
    useWorkspace.setState({
      tabs: [{ id: tabId, kind: "editor", title: "file.txt", hostId: host.id, pinned: false }],
    });
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: session.id,
          path: "/file.txt",
          name: "file.txt",
          content: "changed",
          baseline: "original",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    expect(await runPluginWorkspaceRequest(request("workspace.close", { tabId }))).toEqual({
      closed: false,
      pendingConfirmation: true,
    });
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(useEditors.getState().isDirty(tabId)).toBe(true);
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind === "confirm") await dialog.onConfirm();
    expect(useWorkspace.getState().tabs).toEqual([]);
    expect(useEditors.getState().entries[tabId]).toBeUndefined();
  });

  it("rejects a dirty editor close when another dialog is already open", async () => {
    const tabId = "editor:dirty";
    useWorkspace.setState({
      tabs: [{ id: tabId, kind: "editor", title: "file", hostId: null, pinned: false }],
    });
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: session.id,
          path: "/file",
          name: "file",
          content: "changed",
          baseline: "",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    useDialogs.getState().openHost();
    await expect(runPluginWorkspaceRequest(request("workspace.close", { tabId }))).rejects.toThrow(
      "dialog.busy",
    );
    expect(useDialogs.getState().dialog.kind).toBe("host");
  });
});

describe("plugin dialog and listener lifecycle", () => {
  it("identifies plugin notifications using the installed name", async () => {
    await runPluginWorkspaceRequest(
      request("ui.showMessage", { message: "Done", kind: "success" }),
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      "pluginApi.messageTitleInstalled tool: Done",
      "success",
    );
  });

  it("returns false when the user dismisses a plugin confirmation", async () => {
    const pending = runPluginWorkspaceRequest(request("ui.confirm", { message: "Continue?" }));
    await settle();
    expect(useDialogs.getState().dialog).toMatchObject({
      kind: "confirm",
      title: "pluginApi.confirmTitleInstalled tool",
    });
    useDialogs.getState().close();
    await expect(pending).resolves.toBe(false);
  });

  it("preserves complete multiline tool parameters for a scrollable manual review", async () => {
    const message = `write file\n${"configuration line\n".repeat(9000)}`;
    const pending = runPluginWorkspaceRequest(request("ui.confirm", { message }));
    await settle();
    expect(useDialogs.getState().dialog).toMatchObject({
      kind: "confirm",
      body: message,
      preformatted: true,
    });
    useDialogs.getState().close();
    await expect(pending).resolves.toBe(false);
    await expect(
      runPluginWorkspaceRequest(request("ui.confirm", { message: "x".repeat(220 * 1024 + 1) })),
    ).rejects.toThrow("invalid:message");
  });

  it("does not replace another dialog or remove a later unrelated dialog", async () => {
    useDialogs.getState().openHost();
    await expect(
      runPluginWorkspaceRequest(request("ui.confirm", { message: "Continue?" })),
    ).rejects.toThrow("dialog.busy");
    useDialogs.getState().close();
    const pending = runPluginWorkspaceRequest(request("ui.confirm", { message: "Continue?" }));
    await settle();
    useDialogs.getState().openGroup();
    await expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useDialogs.getState().dialog.kind).toBe("group");
  });

  it("dismisses only the cancelled runtime request when permissions are revoked", async () => {
    cleanup = await wirePluginWorkspaceBridge();
    const pending = runPluginWorkspaceRequest(request("ui.confirm", { message: "Continue?" }));
    await settle();
    emit("plugin://workspace-cancelled", { requestId: "other-request" });
    expect(useDialogs.getState().dialog.kind).toBe("confirm");
    emit("plugin://workspace-cancelled", { requestId: "request-one" });
    await expect(pending).resolves.toBe(false);
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });

  it("times out and closes its own unanswered confirmation", async () => {
    const pending = runPluginWorkspaceRequest(request("ui.confirm", { message: "Continue?" }));
    await settle();
    await vi.advanceTimersByTimeAsync(55_000);
    await expect(pending).resolves.toBe(false);
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });

  it("closes its pending confirmation when the bridge is disposed and cleans up once", async () => {
    cleanup = await wirePluginWorkspaceBridge();
    const pending = runPluginWorkspaceRequest(request("ui.confirm", { message: "Continue?" }));
    await settle();
    cleanup();
    cleanup();
    await expect(pending).resolves.toBe(false);
    expect(useDialogs.getState().dialog.kind).toBe("none");
    expect(mocks.cleanups.every((fn) => fn.mock.calls.length === 1)).toBe(true);
    cleanup = undefined;
  });

  it("reports failures through the fixed reply command and clears registered listeners", async () => {
    cleanup = await wirePluginWorkspaceBridge();
    emit("plugin://workspace-request", request("unknown"));
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith("plugin_workspace_reply", {
      requestId: "request-one",
      result: null,
      error: "unknownMethod",
    });
    cleanup();
    cleanup = undefined;
    expect(mocks.cleanups).toHaveLength(3);
    expect(mocks.cleanups.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  it("cleans up successful registrations if another listener fails", async () => {
    mocks.listen.mockImplementation(async (name: string) => {
      if (name === "plugin://workspace-cancelled") throw new Error("registrationFailed");
      const unlisten = vi.fn();
      mocks.cleanups.push(unlisten);
      return unlisten;
    });
    await expect(wirePluginWorkspaceBridge()).rejects.toThrow("registrationFailed");
    expect(mocks.cleanups).toHaveLength(2);
    expect(mocks.cleanups.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  it("refreshes host names and forwards file and history changes to open views", async () => {
    cleanup = await wirePluginWorkspaceBridge();
    useWorkspace.getState().openHost(host);
    mocks.hostsSnapshot.mockResolvedValue({ hosts: [{ ...host, name: "Renamed" }], groups: [] });
    emit("plugin://domain-changed", { domain: "hosts" });
    await settle();
    expect(useWorkspace.getState().tabs[0]?.title).toBe("Renamed");
    const files = vi.fn();
    const history = vi.fn();
    window.addEventListener("tunnelde:files-changed", files);
    window.addEventListener("tunnelde:history-changed", history);
    emit("plugin://domain-changed", { domain: "files", sessionId: session.id });
    emit("plugin://domain-changed", { domain: "history" });
    expect(files.mock.calls[0]?.[0].detail).toEqual({
      source: { kind: "remote", sessionId: session.id },
      origin: "plugin-api",
    });
    expect(history).toHaveBeenCalledTimes(1);
    window.removeEventListener("tunnelde:files-changed", files);
    window.removeEventListener("tunnelde:history-changed", history);
  });
});
