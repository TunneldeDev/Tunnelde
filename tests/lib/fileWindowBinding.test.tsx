import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
const { onTransfer, onNative } = vi.hoisted(() => ({
  onTransfer: vi.fn().mockResolvedValue(vi.fn()),
  onNative: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("@/lib/api/ipc", () => ({ api: {}, isTauri: () => false, events: { onTransfer } }));
vi.mock("@/lib/events/native", () => ({ nativeEvents: { on: onNative } }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()) }),
}));
import { createFileWindowBinding } from "@/features/sftp/fileWindowBinding";
import { SftpPageView } from "@/features/sftp/SftpPageView";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { filePagePreferenceProjection } from "@/features/sftp/filePageServices";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { FileWindowModel } from "@/features/sftp/fileWindowModel";
import { useDialogs } from "@/store/dialogs";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0).reverse()) stop();
  useWindowViews.setState({ entries: new Map() });
});
beforeEach(() => {
  vi.clearAllMocks();
  useDialogs.getState().close();
});
function fixture(staged = false, initial?: unknown) {
  const lease = { panelId: "files:one", windowId: "target", generation: 2 },
    controller = createPanelViewState(initial);
  let record: WindowViewRecord = {
    panelId: lease.panelId,
    key: "same-tree",
    controller,
    staged,
    lease: staged ? undefined : lease,
  };
  useWindowViews.setState({ entries: new Map([[lease.panelId, record]]) });
  const listing = {
    path: "/qa",
    entries: [
      {
        name: "file.txt",
        path: "/qa/file.txt",
        isDir: false,
        isHidden: false,
        size: 4,
        modified: null,
        permissions: null,
      },
    ],
  };
  const client = {
    windowId: "target",
    files: {
      list: vi.fn().mockResolvedValue(listing),
      home: vi.fn().mockResolvedValue("/qa"),
      mkdir: vi.fn().mockResolvedValue(undefined),
      createFile: vi.fn(),
      rename: vi.fn(),
      copy: vi.fn(),
      remove: vi.fn(),
      transfer: vi.fn().mockResolvedValue("transfer"),
    },
    action: vi.fn().mockResolvedValue(null),
    control: vi.fn().mockResolvedValue("interaction"),
  } as unknown as PanelWindowClient;
  const model: FileWindowModel = {
    appearance: {} as FileWindowModel["appearance"],
    language: "en-us",
    platform: "macos",
    files: {
      props: {
        sessionId: "owner",
        scopeId: lease.panelId,
        tabId: lease.panelId,
        single: { source: { kind: "local" }, path: "/qa", ownerSessionId: "owner" },
      },
      tab: {
        id: lease.panelId,
        kind: "sftp",
        title: "Files",
        hostId: null,
        pinned: false,
        fileSessionId: null,
        fileSessionIds: [],
      },
      sessions: [],
      clip: null,
      preferences: filePagePreferenceProjection(DEFAULT_SETTINGS),
      views: {},
      highlights: [],
      previews: [],
      menus: [],
      providersSelected: false,
    },
  };
  const binding = createFileWindowBinding(client, record, JSON.parse(JSON.stringify(model))),
    unregister = binding.mount();
  cleanups.push(() => {
    unregister();
    binding.dispose();
    controller.dispose();
  });
  return {
    binding,
    client,
    controller,
    model,
    lease,
    record,
    replace(next: Partial<WindowViewRecord>) {
      record = { ...record, ...next };
      useWindowViews.setState({ entries: new Map([[lease.panelId, record]]) });
      binding.activate();
    },
  };
}
it("renders the production file page through the exact staged backend and waits for real directory rendering", async () => {
  const f = fixture(true);
  let ready = false;
  const pending = f.controller.waitReady(new AbortController().signal).then(() => {
    ready = true;
  });
  expect(ready).toBe(false);
  render(
    <PanelViewStateScope controller={f.controller}>
      <SftpPageView {...f.model.files.props} services={f.binding.services} />
    </PanelViewStateScope>,
  );
  await screen.findByText("file.txt");
  await pending;
  expect(ready).toBe(true);
  expect(f.client.files.list).toHaveBeenCalledWith(
    { kind: "staged", id: "same-tree" },
    { kind: "local" },
    "/qa",
  );
  expect(f.client.action).not.toHaveBeenCalled();
});
it("promotes the same renderer's reads/effects to the committed lease and refuses frozen or obsolete work", async () => {
  const f = fixture(true);
  await expect(f.binding.services.fs.mkdir({ kind: "local" }, "/before")).rejects.toThrow(
    "panel.window.staleOwner",
  );
  f.replace({ staged: false, lease: f.lease });
  await f.binding.services.fs.mkdir({ kind: "local" }, "/new");
  expect(f.client.files.mkdir).toHaveBeenCalledWith(f.lease, { kind: "local" }, "/new");
  f.replace({ moving: true });
  await expect(f.binding.services.fs.mkdir({ kind: "local" }, "/frozen")).rejects.toThrow(
    "panel.window.staleOwner",
  );
  expect(f.client.files.mkdir).toHaveBeenCalledOnce();
  f.binding.dispose();
  await expect(async () => f.binding.services.fs.list({ kind: "local" }, "/late")).rejects.toThrow(
    "panel.window.staleOwner",
  );
});
it("defers only derived source/root metadata during staging, then flushes it once after promotion", () => {
  const f = fixture(true);
  f.binding.services.workspace.setFileSession(f.lease.panelId, null, []);
  const roots = [{ id: "root", tabId: f.lease.panelId, path: "/qa", sessionId: null }];
  f.binding.services.searchRoots.publish("renderer", roots);
  expect(f.client.action).not.toHaveBeenCalled();
  f.replace({ staged: false, lease: f.lease });
  expect(f.client.action).toHaveBeenCalledOnce();
  expect(f.client.action).toHaveBeenCalledWith(f.lease, {
    kind: "files",
    command: { operation: "roots", data: { roots } },
  });
  f.binding.activate();
  expect(f.client.action).toHaveBeenCalledOnce();
});
it("projects file menu contributions while resolving every click with the main owner", async () => {
  const f = fixture();
  const contribution = {
    pluginId: "syntax",
    pluginName: "Syntax",
    command: "inspect",
    title: "Inspect",
    first: false,
    fingerprint: "fingerprint",
  };
  const model = {
    ...f.model,
    files: {
      ...f.model.files,
      menus: [
        {
          sources: ["local" as const],
          kinds: ["file" as const],
          extensions: ["txt"],
          action: contribution,
        },
      ],
    },
  };
  f.binding.update(model);
  const entry = {
    name: "file.txt",
    path: "/qa/file.txt",
    isDir: false,
    isHidden: false,
    size: 4,
    modified: null,
    permissions: null,
  };
  const result = f.binding.services.fileMenuCommands({ kind: "local" }, entry);
  expect(result).toEqual([{ ...contribution, first: true }]);
  await f.binding.services.runFileMenuCommand(result[0]!, { kind: "local" }, entry);
  expect(f.client.action).toHaveBeenCalledWith(f.lease, {
    kind: "files",
    command: {
      operation: "menuRun",
      data: { action: result[0], source: { kind: "local" }, entry },
    },
  });
});
it("does not complete readiness until a loading/error state has actually been rendered", async () => {
  const f = fixture();
  let complete = false;
  const pending = f.controller.waitReady(new AbortController().signal).then(() => {
    complete = true;
  });
  f.binding.services.rendered?.(false);
  await Promise.resolve();
  expect(complete).toBe(false);
  f.binding.services.rendered?.(true);
  await pending;
  expect(complete).toBe(true);
});

it("reconstructs highlight indexes after the exact JSON wire roundtrip", () => {
  const f = fixture();
  const highlight = {
    key: "test",
    pluginId: "syntax",
    pluginName: "Syntax",
    source: "local",
    directory: null,
    match: { extension: "txt" },
    tooltip: "Shared highlight",
    tone: "info" as const,
  };
  f.binding.update(
    JSON.parse(
      JSON.stringify({
        ...f.model,
        files: { ...f.model.files, highlights: [["local", [highlight]]] },
      }),
    ),
  );
  function Probe() {
    const model = f.binding.services.useModel();
    return <span>{model.highlights.get("local")?.[0]?.tooltip}</span>;
  }
  render(<Probe />);
  expect(screen.getByText("Shared highlight")).toBeTruthy();
});
it("cleans transfer subscriptions when disposed, including a late subscription acknowledgement", async () => {
  const f = fixture(),
    unlisten = vi.fn(),
    done = vi.fn();
  let acknowledge!: (stop: () => void) => void;
  onTransfer.mockImplementationOnce(
    () =>
      new Promise<() => void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  f.binding.services.watchCutCompletion("transfer", done, () => true);
  const receive = onTransfer.mock.calls[0]![0];
  f.binding.dispose();
  acknowledge(unlisten);
  await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  receive({ id: "transfer", status: "done" });
  expect(done).not.toHaveBeenCalled();
});
it("releases a completed cut subscription exactly once and ignores repeated events", async () => {
  const f = fixture(),
    unlisten = vi.fn(),
    done = vi.fn();
  onTransfer.mockResolvedValueOnce(unlisten);
  f.binding.services.watchCutCompletion("transfer", done, () => true);
  await Promise.resolve();
  const receive = onTransfer.mock.calls[0]![0];
  receive({ id: "transfer", status: "done" });
  receive({ id: "transfer", status: "done" });
  f.binding.dispose();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(done).toHaveBeenCalledOnce();
});
it("holds an exact native interaction throughout confirmation and closes its own dialog on disposal", async () => {
  const f = fixture(),
    confirm = vi.fn();
  f.binding.services.confirm({
    title: "Delete",
    body: "file",
    confirmLabel: "Delete",
    onConfirm: confirm,
  });
  await waitFor(() => expect(useDialogs.getState().dialog.kind).toBe("confirm"));
  expect(f.client.control).toHaveBeenCalledWith({ action: "beginInteraction", lease: f.lease });
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  f.replace({ moving: true });
  if (dialog.kind === "confirm")
    await expect(dialog.onConfirm()).rejects.toThrow("panel.window.staleOwner");
  expect(confirm).not.toHaveBeenCalled();
  act(() => f.binding.dispose());
  expect(useDialogs.getState().dialog.kind).toBe("none");
  expect(f.client.control).toHaveBeenLastCalledWith({
    action: "endInteraction",
    lease: f.lease,
    id: "interaction",
  });
});
it("releases a late confirmation permit without opening a stale dialog", async () => {
  const f = fixture();
  let acknowledge!: (id: string) => void;
  vi.mocked(f.client.control).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve as (id: string) => void;
      }),
  );
  f.binding.services.confirm({
    title: "Delete",
    body: "file",
    confirmLabel: "Delete",
    onConfirm: vi.fn(),
  });
  f.binding.dispose();
  acknowledge("late");
  await waitFor(() =>
    expect(f.client.control).toHaveBeenLastCalledWith({
      action: "endInteraction",
      lease: f.lease,
      id: "late",
    }),
  );
  expect(useDialogs.getState().dialog.kind).toBe("none");
});

it("does not acknowledge a restored listing before its staged source read settles", async () => {
  const source = fixture();
  const view = render(
    <PanelViewStateScope controller={source.controller}>
      <SftpPageView {...source.model.files.props} services={source.binding.services} />
    </PanelViewStateScope>,
  );
  await screen.findByText("file.txt");
  await source.controller.waitReady(new AbortController().signal);
  const capsule = await source.controller.captureAsync();
  view.unmount();
  const staged = fixture(true, capsule);
  let resolve!: (listing: { path: string; entries: never[] }) => void;
  vi.mocked(staged.client.files.list).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(
    <PanelViewStateScope controller={staged.controller}>
      <SftpPageView {...staged.model.files.props} services={staged.binding.services} />
    </PanelViewStateScope>,
  );
  let ready = false;
  const pending = staged.controller.waitReady(new AbortController().signal).then(() => {
    ready = true;
  });
  await waitFor(() => expect(staged.client.files.list).toHaveBeenCalled());
  expect(ready).toBe(false);
  await act(async () => {
    resolve({ path: "/qa", entries: [] });
  });
  await pending;
  expect(ready).toBe(true);
});
