import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowForwardingSection } from "@/features/forwarding/components/WindowForwardingSection";
import { createWindowForwardingActions } from "@/features/forwarding/runtime/windowActions";
import { ForwardingReadScope } from "@/features/forwarding/data/readScope";
import type { ForwardingReadData } from "@/features/forwarding/data/readModel";
import type { ForwardingWindowMutation } from "@/features/forwarding/runtime/windowProtocol";
import type { ForwardInfo } from "@/features/forwarding/model/contract";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { NativeForwardingPromptClient } from "@/features/forwarding/runtime/windowPrompt";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { usePanelWindows } from "@/store/panelWindows";
const raw = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: raw.invoke }));
const original = {
  windows: usePanelWindows.getState(),
  dialogs: useDialogs.getState(),
  ssh: useSsh.getState(),
};
const lease = { panelId: "forwarding", windowId: "satellite", generation: 7 };
const host = {
  id: "host",
  name: "Server",
  host: "example",
  username: "qa",
  port: 22,
  authMethod: "password" as const,
};
const plan = { host, jumpHosts: [], review: { hostId: "host", revision: "a".repeat(64) } };
const session = { id: "ssh", hostId: "host", purpose: "forwarding", address: "qa@example:22" };
function rule(id = "rule"): ForwardInfo {
  return {
    id,
    hostId: "host",
    name: id === "rule" ? "Database" : id,
    revision: `revision-${id}`,
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 8080,
    targetHost: "localhost",
    targetPort: 80,
    active: false,
    sessionId: null,
    runtimeId: null,
    automation: { autoStart: true, autoRetry: true },
  };
}
beforeEach(() => {
  usePanelWindows.setState({ windowId: "satellite", available: false });
  useDialogs.setState({ dialog: { kind: "none" } });
  useSsh.setState({ sessions: [] });
});
afterEach(() => {
  cleanup();
  expect(raw.invoke).not.toHaveBeenCalled();
  expect(useDialogs.getState().dialog).toEqual({ kind: "none" });
  expect(useSsh.getState().sessions).toEqual([]);
  usePanelWindows.setState(original.windows, true);
  useDialogs.setState(original.dialogs, true);
  useSsh.setState(original.ssh, true);
  vi.clearAllMocks();
});
function fixture(provider = false) {
  let serial = 0;
  const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
    r.action === "beginInteraction" ? `original-${++serial}` : null,
  );
  const mutation = vi.fn(async (_lease: unknown, r: ForwardingWindowMutation): Promise<unknown> => {
    switch (r.operation) {
      case "prepareStart":
        return structuredClone(plan);
      case "start":
        if (!r.credentials?.password) throw { code: "ssh", message: "ssh.passwordRequired" };
        if (r.id === "occupied") throw new Error("forward.bindFailed");
        return session;
      case "probe":
        return { hostId: "host", status: "known", fingerprint: "SHA256:reviewed" };
      case "credentialStatus":
        return false;
      case "save":
        return { ...r.rule, revision: "saved", groupId: r.groupId, automation: r.automation };
      default:
        return null;
    }
  });
  const client = { control, forwardingMutation: mutation } as unknown as PanelWindowClient;
  const refresh = vi.fn(),
    report = vi.fn();
  const service = createWindowForwardingActions(client, lease, { check: vi.fn(), refresh, report });
  const providerMutation = vi.fn(
    async (_token: string, lease: unknown, r: ForwardingWindowMutation) => mutation(lease, r),
  );
  const authority = provider
    ? service.createProviderAuthority({
        hostId: "host",
        token: "original-native-child",
        client: { forwardingMutation: providerMutation } as unknown as NativeForwardingPromptClient,
        check: vi.fn(),
      })
    : undefined;
  let data: ForwardingReadData = {
    hosts: [host],
    hostsLoading: false,
    sessions: [],
    rules: { entries: [rule()], busy: false, error: null },
    groups: { entries: [], busy: false, error: null },
  };
  const tree = () => (
    <ForwardingReadScope value={data}>
      <WindowForwardingSection
        client={client}
        lease={lease}
        service={service}
        host={host}
        renderSurface={({ controller, children }) =>
          provider ? (
            <>
              <button onClick={() => controller.startTargets(controller.rules, authority)}>
                Provider start
              </button>
              <button onClick={() => controller.requestRemove(controller.rules[0]!, authority)}>
                Provider delete
              </button>
            </>
          ) : (
            children
          )
        }
      />
    </ForwardingReadScope>
  );
  return {
    client,
    control,
    mutation,
    providerMutation,
    service,
    refresh,
    report,
    tree,
    setData: (next: ForwardingReadData) => {
      data = next;
    },
    getData: () => data,
  };
}
async function connect() {
  await screen.findByText("Trusted");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ephemeral-only" } });
  const remember = screen.getByLabelText("Remember password");
  if (remember.getAttribute("aria-checked") === "true") fireEvent.click(remember);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
it("composes the actual action service, original automatic attempt and native shared prompt without main-store effects", async () => {
  const f = fixture();
  render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await connect();
  const starts = f.mutation.mock.calls.map(([, r]) => r).filter((r) => r.operation === "start");
  expect(starts).toHaveLength(2);
  expect(starts[0]).toMatchObject({ interaction: "original-1", credentials: { password: null } });
  expect(starts[1]).toMatchObject({
    interaction: "original-2",
    credentials: { password: "ephemeral-only" },
  });
  expect(
    f.control.mock.calls.filter(([r]) => r.action === "endInteraction").map(([r]) => r),
  ).toEqual([
    { action: "endInteraction", lease, id: "original-1" },
    { action: "endInteraction", lease, id: "original-2" },
  ]);
  expect(f.refresh).toHaveBeenCalledTimes(2);
  expect(f.providerMutation).not.toHaveBeenCalled();
  expect(f.mutation.mock.calls.some(([, r]) => r.operation === "saveCredential")).toBe(false);
});
it("keeps provider batch on its original native child and reviewed target revisions after authoritative model refresh", async () => {
  const f = fixture(true);
  f.setData({
    ...f.getData(),
    rules: { entries: [rule(), rule("occupied"), rule("later")], busy: false, error: null },
  });
  const view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Provider start" }));
  await screen.findByText("Trusted");
  f.setData({
    ...f.getData(),
    rules: { entries: [rule("replacement")], busy: false, error: null },
  });
  view.rerender(f.tree());
  await connect();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("occupied:"),
  );
  const starts = f.providerMutation.mock.calls
    .map(([, , r]) => r)
    .filter((r) => r.operation === "start");
  expect(starts.map((r) => [r.id, r.revision, r.interaction])).toEqual([
    ["rule", "revision-rule", "original-1"],
    ["rule", "revision-rule", "original-2"],
    ["occupied", "revision-occupied", "original-2"],
    ["later", "revision-later", "original-2"],
  ]);
  expect(f.providerMutation.mock.calls.every(([token]) => token === "original-native-child")).toBe(
    true,
  );
  expect(f.mutation).toHaveBeenCalledTimes(f.providerMutation.mock.calls.length);
});
it("composes actual original-window deletion confirmation with the native factory and captured runtime", async () => {
  const f = fixture();
  const view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  await screen.findByRole("button", { name: "Delete" });
  f.setData({
    ...f.getData(),
    rules: {
      entries: [{ ...rule(), revision: "replacement", runtimeId: "replacement" }],
      busy: false,
      error: null,
    },
  });
  view.rerender(f.tree());
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.mutation).toHaveBeenCalledExactlyOnceWith(lease, {
    operation: "remove",
    id: "rule",
    revision: "revision-rule",
    runtimeId: null,
    interaction: "original-1",
  });
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original-1" });
});
it("preserves displayed automation while editing through the actual native action service", async () => {
  const f = fixture();
  render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(f.mutation).toHaveBeenCalled());
  expect(f.mutation.mock.calls[0]?.[1]).toMatchObject({
    operation: "save",
    revision: "revision-rule",
    automation: { autoStart: true, autoRetry: true },
  });
});
it("keeps the native provider deletion on its exact child through the shared confirmation", async () => {
  const f = fixture(true);
  render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Provider delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.providerMutation).toHaveBeenCalledExactlyOnceWith("original-native-child", lease, {
    operation: "remove",
    id: "rule",
    revision: "revision-rule",
    runtimeId: null,
    interaction: "original-1",
  });
  expect(f.mutation).toHaveBeenCalledOnce();
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original-1" });
});
it("renders owner retirement during refresh as an error without an unhandled action completion", async () => {
  const f = fixture();
  f.refresh.mockImplementation(() => {
    throw new Error("panel.window.staleOwner");
  });
  render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("panel.window.staleOwner"),
  );
  expect(f.mutation).toHaveBeenCalledOnce();
});
it("unmounting during automatic preparation retires original consent and cannot mount a late main/native prompt", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.mutation.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(f.mutation).toHaveBeenCalledOnce());
  view.unmount();
  f.service.dispose();
  await act(async () => {
    resolve(plan);
  });
  await waitFor(() =>
    expect(f.control).toHaveBeenLastCalledWith({
      action: "endInteraction",
      lease,
      id: "original-1",
    }),
  );
  expect(f.mutation).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.refresh).not.toHaveBeenCalled();
});
