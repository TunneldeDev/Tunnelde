import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true }));
import "@/i18n/i18n";
import { ForwardingSection } from "@/features/forwarding/ForwardingSection";
import { ForwardingReadScope } from "@/features/forwarding/data/readScope";
import { ForwardingActionScope } from "@/features/forwarding/runtime/actionScope";
import type { ForwardingActions } from "@/features/forwarding/runtime/actions";
import type { ForwardingReadData } from "@/features/forwarding/data/readModel";
import type { Host, SshSession } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { usePanelWindows } from "@/store/panelWindows";
import { useDialogs } from "@/store/dialogs";
const original = {
  ssh: useSsh.getState(),
  windows: usePanelWindows.getState(),
  dialogs: useDialogs.getState(),
};
const host = { id: "host", name: "Server" } as Host;
const group = { id: "group", hostId: "host", name: "Services", revision: "g1" };
let actions: ForwardingActions;
let data: ForwardingReadData;
beforeEach(() => {
  invoke.mockReset().mockRejectedValue(new Error("raw IPC must not be used"));
  useSsh.setState({ sessions: [] });
  usePanelWindows.setState({ windowId: "satellite" });
  useDialogs.setState({ dialog: { kind: "none" } });
  actions = {
    refresh: vi.fn(),
    start: vi.fn(
      async () => ({ id: "connected", hostId: "host", purpose: "forwarding" }) as SshSession,
    ),
    save: vi.fn(async (rule) => ({ ...rule, id: rule.id || "created", revision: "saved" })),
    remove: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    saveGroup: vi.fn(async (_host, name) => ({ ...group, name })),
    removeGroup: vi.fn(async () => {}),
    copyAddress: vi.fn(async () => {}),
  };
  data = {
    hosts: [],
    hostsLoading: false,
    sessions: [],
    rules: {
      entries: [
        {
          id: "rule",
          hostId: "host",
          name: "Database",
          mode: "local",
          bindHost: "127.0.0.1",
          bindPort: 8080,
          targetHost: "localhost",
          targetPort: 80,
          revision: "one",
          active: false,
          sessionId: null,
        },
      ],
      busy: false,
      error: null,
    },
    groups: { entries: [group], busy: false, error: null },
  };
});
afterEach(() => {
  useSsh.setState(original.ssh, true);
  usePanelWindows.setState(original.windows, true);
  useDialogs.setState(original.dialogs, true);
});
const tree = () => (
  <ForwardingReadScope value={data}>
    <ForwardingActionScope value={actions}>
      <ForwardingSection host={host} />
    </ForwardingActionScope>
  </ForwardingReadScope>
);
it("runs the same rule UI against scoped data/actions without native reads or writable SSH hydration", async () => {
  const view = render(tree());
  expect(screen.getByText("Database")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Services" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(actions.start).toHaveBeenCalledOnce());
  expect(actions.start).toHaveBeenCalledWith(
    data.rules.entries![0],
    undefined,
    undefined,
    undefined,
  );
  await waitFor(() => expect(actions.refresh).toHaveBeenCalled());
  data = {
    ...data,
    sessions: [{ id: "connected", hostId: "host", purpose: "forwarding" }],
    rules: {
      ...data.rules,
      entries: [
        { ...data.rules.entries![0]!, active: true, sessionId: "connected", runtimeId: "runtime" },
      ],
    },
  };
  view.rerender(tree());
  expect(screen.getByText("Running")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(actions.stop).toHaveBeenCalledWith(data.rules.entries![0], undefined));
  expect(useSsh.getState().sessions).toEqual([]);
  expect(invoke).not.toHaveBeenCalled();
});
it("keeps scoped failures visible without falling back to the local service", async () => {
  vi.mocked(actions.start).mockRejectedValue(new Error("exact lease expired"));
  render(tree());
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("exact lease expired"),
  );
  expect(actions.start).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});
it("routes group create, rename and removal through scoped services including partial-failure refresh", async () => {
  render(tree());
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "New" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(actions.saveGroup).toHaveBeenCalledWith("host", "New", undefined));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const region = screen.getByRole("region", { name: "Services" });
  fireEvent.click(within(region).getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Renamed" },
  });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Group name" }), { key: "Enter" });
  await waitFor(() => expect(actions.saveGroup).toHaveBeenCalledWith("host", "Renamed", group));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  vi.mocked(actions.removeGroup).mockRejectedValue(new Error("partially failed"));
  fireEvent.click(within(region).getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(actions.removeGroup).toHaveBeenCalledWith(group));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "partially failed");
  expect(actions.refresh).toHaveBeenCalledTimes(3);
  expect(invoke).not.toHaveBeenCalled();
});
it("routes clipboard, revision-bound save and confirmed deletion through scoped services", async () => {
  render(tree());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy local connection address" }));
  expect(actions.copyAddress).toHaveBeenCalledWith("127.0.0.1:8080");
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(actions.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rule", hostId: "host" }),
      "one",
      undefined,
    ),
  );
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind !== "confirm") throw new Error("missing confirmation");
  await act(async () => {
    await dialog.onConfirm();
  });
  expect(actions.remove).toHaveBeenCalledWith(data.rules.entries![0], undefined);
  expect(invoke).not.toHaveBeenCalled();
});

it("continues a captured disconnect batch after an individual failure and reports it in the originating UI", async () => {
  data = {
    ...data,
    sessions: ["one", "two"].map((id) => ({ id, hostId: "host", purpose: "forwarding" })),
  };
  vi.mocked(actions.disconnect).mockRejectedValueOnce(new Error("first session failed"));
  render(tree());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  const dialog = useDialogs.getState().dialog;
  if (dialog.kind !== "confirm") throw new Error("missing origin confirmation");
  await act(async () => {
    await dialog.onConfirm();
  });
  expect(actions.disconnect).toHaveBeenNthCalledWith(1, "host", "one", undefined);
  expect(actions.disconnect).toHaveBeenNthCalledWith(2, "host", "two", undefined);
  expect(screen.getByRole("alert").textContent).toContain("first session failed");
  expect(invoke).not.toHaveBeenCalled();
});

it("refuses incomplete satellite scopes before starting raw readers or effects", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => render(<ForwardingSection host={host} />)).toThrow("panel.window.unsupportedView");
    expect(() =>
      render(
        <ForwardingActionScope value={actions}>
          <ForwardingSection host={host} />
        </ForwardingActionScope>,
      ),
    ).toThrow("panel.window.unsupportedView");
    expect(invoke).not.toHaveBeenCalled();
    expect(actions.start).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});
