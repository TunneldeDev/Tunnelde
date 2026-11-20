import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowForwardingConfirmationScope } from "@/features/forwarding/components/WindowForwardingConfirmationScope";
import {
  useForwardingConfirm,
  type ForwardingConfirm,
} from "@/features/forwarding/runtime/confirmationScope";
import { ForwardingSection } from "@/features/forwarding/ForwardingSection";
import { ForwardingReadScope } from "@/features/forwarding/data/readScope";
import { ForwardingActionScope } from "@/features/forwarding/runtime/actionScope";
import type { ForwardingActions } from "@/features/forwarding/runtime/actions";
import type { ForwardingReadData } from "@/features/forwarding/data/readModel";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { Host, SshSession } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
const raw = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: raw.invoke }));
const original = {
  windows: usePanelWindows.getState(),
  dialogs: useDialogs.getState(),
  ssh: useSsh.getState(),
};
const lease = { panelId: "forwarding", windowId: "satellite", generation: 7 };
const host = { id: "host", name: "Server" } as Host;
let actions: ForwardingActions;
let data: ForwardingReadData;
beforeEach(() => {
  usePanelWindows.setState({ windowId: "satellite", available: false });
  useDialogs.setState({ dialog: { kind: "none" } });
  useSsh.setState({ sessions: [] });
  actions = {
    refresh: vi.fn(),
    start: vi.fn(async () => ({ id: "s", hostId: "host", purpose: "forwarding" }) as SshSession),
    save: vi.fn(async (rule) => ({ ...rule, id: rule.id || "new", revision: "saved" })),
    remove: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    saveGroup: vi.fn(),
    removeGroup: vi.fn(async () => {}),
    copyAddress: vi.fn(async () => {}),
  };
  data = {
    hosts: [],
    hostsLoading: false,
    sessions: [],
    groups: { entries: [], busy: false, error: null },
    rules: {
      entries: [
        {
          id: "rule",
          hostId: "host",
          name: "Database",
          revision: "reviewed",
          mode: "local",
          bindHost: "127.0.0.1",
          bindPort: 8080,
          targetHost: "localhost",
          targetPort: 80,
          active: false,
          sessionId: null,
          runtimeId: null,
        },
      ],
      busy: false,
      error: null,
    },
  };
});
afterEach(() => {
  cleanup();
  expect(raw.invoke).not.toHaveBeenCalled();
  expect(useSsh.getState().sessions).toEqual([]);
  usePanelWindows.setState(original.windows, true);
  useDialogs.setState(original.dialogs, true);
  useSsh.setState(original.ssh, true);
  vi.clearAllMocks();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let serial = 0;
  const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
    r.action === "beginInteraction" ? `original-${++serial}` : null,
  );
  const client = { control } as unknown as PanelWindowClient;
  const tree = (nextClient = client, nextLease = lease) => (
    <ForwardingReadScope value={data}>
      <ForwardingActionScope value={actions}>
        <WindowForwardingConfirmationScope client={nextClient} lease={{ ...nextLease }}>
          <ForwardingSection host={host} />
        </WindowForwardingConfirmationScope>
      </ForwardingActionScope>
    </ForwardingReadScope>
  );
  return { client, control, tree };
}
function requestDelete() {
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
}
it("acquires original consent before rendering any destructive approval; Cancel retires a late acquisition", async () => {
  const f = fixture(),
    admitted = deferred<unknown>();
  f.control.mockImplementation((r) =>
    r.action === "beginInteraction" ? admitted.promise : Promise.resolve(null),
  );
  const view = render(f.tree());
  requestDelete();
  expect(within(screen.getByRole("dialog")).getByRole("status")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(useDialogs.getState().dialog.kind).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  view.unmount();
  await act(async () => {
    admitted.resolve("late-original");
  });
  await waitFor(() =>
    expect(f.control).toHaveBeenLastCalledWith({
      action: "endInteraction",
      lease,
      id: "late-original",
    }),
  );
  expect(actions.remove).not.toHaveBeenCalled();
  expect(f.control).toHaveBeenCalledTimes(2);
});
it("passes exact original token and captured rule/runtime despite read-model refresh, and keeps consent until actual completion", async () => {
  const f = fixture(),
    done = deferred<void>();
  vi.mocked(actions.remove).mockReturnValue(done.promise);
  const view = render(f.tree());
  requestDelete();
  await screen.findByRole("button", { name: "Delete" });
  const reviewed = structuredClone(data.rules.entries![0]);
  data.rules.entries![0]!.revision = "changed";
  data.rules.entries![0]!.runtimeId = "replacement";
  data = {
    ...data,
    rules: { ...data.rules, entries: [{ ...data.rules.entries![0]!, name: "Updated" }] },
  };
  view.rerender(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(actions.remove).toHaveBeenCalledWith(reviewed, undefined, "original-1"),
  );
  expect(f.control).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  view.unmount();
  await waitFor(() => expect(f.control).toHaveBeenCalledTimes(2));
  await act(async () => {
    done.resolve();
  });
  expect(actions.remove).toHaveBeenCalledOnce();
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original-1" });
});
it("binds exposed listener save to the dialog's interaction and editable snapshot", async () => {
  const f = fixture();
  render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  const fields = screen.getAllByRole("textbox");
  const listener = fields.find((x) => (x as HTMLInputElement).value === "127.0.0.1")!;
  fireEvent.change(listener, { target: { value: "0.0.0.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Save" });
  const dialog = screen.getByRole("dialog");
  expect(actions.save).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(actions.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "", bindHost: "0.0.0.0" }),
      undefined,
      undefined,
      "original-1",
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original-1" });
});
it("keeps disconnect batch targets and original consent stable while reporting an individual failure", async () => {
  data.sessions = ["one", "two"].map((id) => ({ id, hostId: "host", purpose: "forwarding" }));
  vi.mocked(actions.disconnect).mockRejectedValueOnce(new Error("first failed"));
  const f = fixture(),
    view = render(f.tree());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Disconnect" });
  const dialog = screen.getByRole("dialog");
  data = {
    ...data,
    sessions: [...data.sessions, { id: "new", hostId: "host", purpose: "forwarding" }],
  };
  view.rerender(f.tree());
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(actions.disconnect).toHaveBeenCalledTimes(2));
  expect(actions.disconnect).toHaveBeenNthCalledWith(1, "host", "one", undefined, "original-1");
  expect(actions.disconnect).toHaveBeenNthCalledWith(2, "host", "two", undefined, "original-1");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "first failed");
  await waitFor(() => expect(f.control).toHaveBeenCalledTimes(2));
});
it("renders acquisition failure without approval, then requires a fresh interaction for retry", async () => {
  const f = fixture();
  f.control.mockRejectedValueOnce(new Error("original window retired"));
  render(f.tree());
  requestDelete();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "original window retired");
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  requestDelete();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(actions.remove).toHaveBeenCalledWith(expect.anything(), undefined, "original-1"),
  );
  await waitFor(() => expect(f.control).toHaveBeenCalledTimes(3));
});
it("StrictMode and equivalent model refresh never duplicate or reacquire visible confirmation", async () => {
  const f = fixture(),
    view = render(<StrictMode>{f.tree()}</StrictMode>);
  requestDelete();
  await screen.findByRole("button", { name: "Delete" });
  view.rerender(<StrictMode>{f.tree()}</StrictMode>);
  expect(f.control).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(f.control).toHaveBeenCalledTimes(2));
  expect(actions.remove).not.toHaveBeenCalled();
});
it("replacing lease before acquisition retires only old consent and cannot show its late dialog", async () => {
  const f = fixture(),
    admitted = deferred<unknown>();
  f.control.mockImplementationOnce(() => admitted.promise);
  const view = render(f.tree());
  requestDelete();
  view.rerender(f.tree(f.client, { ...lease, generation: 8 }));
  await act(async () => {
    admitted.resolve("old");
  });
  await waitFor(() =>
    expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "old" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  requestDelete();
  await screen.findByRole("button", { name: "Delete" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(f.control).toHaveBeenLastCalledWith({
      action: "endInteraction",
      lease: { ...lease, generation: 8 },
      id: "original-1",
    }),
  );
});
it("client replacement rejects retained old continuations, hides old UI, and does not borrow a replacement's consent", async () => {
  const f = fixture();
  let retained!: ForwardingConfirm;
  function Caller() {
    retained = useForwardingConfirm();
    return (
      <button
        onClick={() =>
          retained({
            title: "Review",
            body: "Original",
            confirmLabel: "Approve",
            onConfirm: vi.fn(),
          })
        }
      >
        Open
      </button>
    );
  }
  const tree = (client: PanelWindowClient) => (
    <WindowForwardingConfirmationScope client={client} lease={lease}>
      <Caller />
    </WindowForwardingConfirmationScope>
  );
  const view = render(tree(f.client));
  fireEvent.click(screen.getByText("Open"));
  await screen.findByText("Original");
  const old = retained,
    next = fixture();
  view.rerender(tree(next.client));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(() => old({ title: "Old", body: "Old", confirmLabel: "Old", onConfirm: vi.fn() })).toThrow(
    "disposed",
  );
  fireEvent.click(screen.getByText("Open"));
  await screen.findByText("Original");
  act(() =>
    retained({
      title: "Replacement",
      body: "Replacement",
      confirmLabel: "Replacement",
      onConfirm: vi.fn(),
    }),
  );
  expect(screen.queryByText("Replacement")).toBeNull();
  expect(next.control).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(next.control).toHaveBeenCalledTimes(2));
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original-1" });
});

it("blocks capture during original confirmation but never checkpoints its approval or token", async () => {
  const f = fixture(),
    controller = createPanelViewState();
  render(<PanelViewStateScope controller={controller}>{f.tree()}</PanelViewStateScope>);
  expect(JSON.stringify(controller.capture())).not.toContain("original-1");
  requestDelete();
  expect(() => controller.capture()).toThrow("panels.finishInteractionBeforeMoving");
  await screen.findByRole("button", { name: "Delete" });
  expect(() => controller.capture()).toThrow("panels.finishInteractionBeforeMoving");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(JSON.stringify(controller.capture())).not.toContain("original-1");
  expect(actions.remove).not.toHaveBeenCalled();
});
