import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
vi.mock("@/features/connect/ConnectDialog", () => ({
  ConnectDialog: ({
    onConnected,
    onClose,
  }: {
    onConnected: (session: unknown) => void;
    onClose: () => void;
  }) => (
    <button
      onClick={() => {
        const session = {
          id: "forward",
          hostId: "host",
          title: "server",
          address: "user@server:22",
          cols: 80,
          rows: 24,
          connectedAt: 1,
          purpose: "forwarding",
        };
        useSsh.setState((state) => ({ sessions: [...state.sessions, session] }));
        onConnected(session);
        onClose();
      }}
    >
      Connect forwarding
    </button>
  ),
}));
import "@/i18n/i18n";
import { ForwardingSection, type ForwardRule } from "@/features/forwarding/ForwardingSection";
import type { Host } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import { domainEvents } from "@/lib/events/domain";
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session/clipboard", () => ({ copyText: copyMock }));
const host = { id: "host", name: "server" } as Host;
let rows: (ForwardRule & { active: boolean; sessionId: string | null; revision: string })[];
beforeEach(() => {
  rows = [];
  copyMock.mockReset();
  invokeMock.mockReset().mockImplementation(async (command, args) => {
    if (command === "forwarding_list") return rows;
    if (command === "forwarding_save") {
      if (
        args.expectedRevision &&
        rows.find((row) => row.id === args.rule.id)?.revision !== args.expectedRevision
      )
        throw { code: "validation", message: "forward.changed" };
      rows = [
        { ...args.rule, id: "rule", active: false, sessionId: null, revision: crypto.randomUUID() },
      ];
      return rows[0];
    }
    if (command === "forwarding_start") {
      if (
        args.expectedRevision &&
        rows.find((row) => row.id === args.id)?.revision !== args.expectedRevision
      )
        throw { code: "validation", message: "forward.changed" };
      rows = rows.map((r) =>
        r.id === args.id ? { ...r, active: true, sessionId: args.sessionId } : r,
      );
    }
    if (command === "forwarding_stop") {
      rows = rows.map((r) => ({ ...r, active: false, sessionId: null }));
    }
    if (command === "forwarding_remove") {
      if (
        args.expectedRevision &&
        rows.find((row) => row.id === args.id)?.revision !== args.expectedRevision
      )
        throw { code: "validation", message: "forward.changed" };
      rows = rows.filter((row) => row.id !== args.id);
    }
  });
  useSsh.setState({ sessions: [] });
  useDialogs.setState({ confirm: vi.fn(), openConnect: vi.fn() });
});
it("starts multiple ports on the same forwarding connection and clears stale status after disconnect", async () => {
  rows = ["one", "two"].map((id, index) => ({
    id,
    hostId: "host",
    name: id,
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 8000 + index,
    targetHost: "127.0.0.1",
    targetPort: 80,
    active: false,
    sessionId: null,
    revision: "initial-version",
  }));
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start all" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect forwarding" }));
  await waitFor(() => expect(screen.getAllByText("Running")).toHaveLength(2));
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "one",
    sessionId: "forward",
    expectedRevision: "initial-version",
  });
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "two",
    sessionId: "forward",
    expectedRevision: "initial-version",
  });
  act(() => useSsh.setState({ sessions: [] }));
  await waitFor(() => expect(screen.queryAllByText("Running")).toHaveLength(0));
  expect(screen.getAllByText("Stopped")).toHaveLength(2);
});
it("continues starting other ports when one fails", async () => {
  rows = ["one", "two"].map((id, index) => ({
    id,
    hostId: "host",
    name: id,
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 8000 + index,
    targetHost: "127.0.0.1",
    targetPort: 80,
    active: false,
    sessionId: null,
    revision: "initial-version",
  }));
  connect();
  const implementation = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_start" && args.id === "one") throw new Error("Port occupied");
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start all" }));
  expect((await screen.findByRole("alert")).textContent).toContain("one: Port occupied");
  expect(screen.getByText("Running")).toBeTruthy();
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "two",
    sessionId: "current",
    expectedRevision: "initial-version",
  });
});
it("keeps disconnect available when a background connection has no remaining rules", async () => {
  connect();
  render(<ForwardingSection host={host} />);
  expect(await screen.findByRole("button", { name: "Disconnect" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start all" })).toBeNull();
});
it("starts a saved rule using a dedicated connection, then stops it", async () => {
  await act(async () => {
    render(<ForwardingSection host={host} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Database" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Database");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect forwarding" }));
  expect(invokeMock).toHaveBeenCalledWith("forwarding_save", {
    rule: expect.objectContaining({
      hostId: "host",
      bindHost: "127.0.0.1",
      targetHost: "127.0.0.1",
    }),
  });
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "rule",
    sessionId: "forward",
    expectedRevision: expect.any(String),
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await screen.findByText("Stopped");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_stop", { id: "rule" });
});
it("requires confirmation before saving a listener exposed to other devices", async () => {
  await act(async () => {
    render(<ForwardingSection host={host} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Public" } });
  fireEvent.change(screen.getByLabelText("Local listen address"), { target: { value: "0.0.0.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(useDialogs.getState().confirm).toHaveBeenCalledWith(
    expect.objectContaining({ danger: true }),
  );
  expect(invokeMock).not.toHaveBeenCalledWith("forwarding_save", expect.anything());
});

it("explains endpoint ownership and never reuses a terminal session", async () => {
  useSsh.setState({
    sessions: ["other", "current"].map((id) => ({
      id,
      hostId: "host",
      title: id,
      address: "server:22",
      cols: 80,
      rows: 24,
      connectedAt: 0,
    })),
  });
  await act(async () => {
    render(<ForwardingSection host={host} />);
  });
  expect(screen.queryByRole("button", { name: "SSH session" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  expect(screen.getByLabelText("Local listen address")).toBeTruthy();
  expect(screen.getByLabelText("Remote service address")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Share a local service/ }));
  expect(screen.getByLabelText("Remote listen address")).toBeTruthy();
  expect(screen.getByLabelText("Local service address")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Share local app" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Share local app");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect forwarding" }));
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "rule",
    sessionId: "forward",
    expectedRevision: expect.any(String),
  });
});

const connect = () =>
  useSsh.setState({
    sessions: [
      {
        id: "current",
        hostId: "host",
        title: "server",
        address: "server:22",
        cols: 80,
        rows: 24,
        connectedAt: 0,
        purpose: "forwarding",
      },
    ],
  });

it("keeps the editor separate from the list", async () => {
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  expect(screen.getByRole("button", { name: "Save and start" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("127.0.0.1:80", { selector: "strong" });
  expect(invokeMock).toHaveBeenCalledWith("forwarding_save", {
    rule: expect.objectContaining({ name: "127.0.0.1:80" }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  expect(screen.queryByRole("list", { name: "Port forwarding" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("list", { name: "Port forwarding" })).toBeTruthy();
});

it("saves and starts once, then offers editing and deletion in the rule menu", async () => {
  connect();
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Remote service port"), { target: { value: "5432" } });
  fireEvent.change(screen.getByLabelText("Local listen port"), { target: { value: "15432" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "rule",
    sessionId: "current",
    expectedRevision: expect.any(String),
  });
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "forwarding_save")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Actions for 127.0.0.1:5432" }));
  expect((screen.getByRole("menuitem", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy local connection address" }));
  expect(copyMock).toHaveBeenCalledWith("127.0.0.1:15432");
});

it("preserves a saved rule after startup fails, shows its error inline and retries without saving again", async () => {
  connect();
  const implementation = invokeMock.getMockImplementation()!;
  let failStart = true;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_start" && failStart)
      throw { code: "ssh", message: "forward.bindFailed" };
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  const error = await screen.findByRole("alert");
  expect(error.closest("li")?.textContent).toContain("127.0.0.1:80");
  expect(screen.queryByRole("form")).toBeNull();
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  failStart = false;
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Running");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "forwarding_save")).toHaveLength(1);
});

it("preserves the draft after saving fails and validates ports before invoking the backend", async () => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "forwarding_list") return [];
    throw new Error("Save unavailable");
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep my draft" } });
  const port = screen.getByLabelText("Local listen port") as HTMLInputElement;
  fireEvent.change(port, { target: { value: "65536" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(port.validity.rangeOverflow).toBe(true);
  expect(invokeMock).not.toHaveBeenCalledWith("forwarding_save", expect.anything());
  fireEvent.change(port, { target: { value: "8080" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Save unavailable");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Keep my draft");
});

it("brackets IPv6 addresses and keeps newer rules when an old refresh completes late", async () => {
  let resolveOld!: (value: unknown[]) => void;
  invokeMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Remote service address"), { target: { value: "::1" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("[::1]:80", { selector: "strong" });
  await act(async () => resolveOld([]));
  expect(screen.getByText("[::1]:80", { selector: "strong" })).toBeTruthy();
});

it("refreshes another open forwarding view after a mutation without resetting its editor", async () => {
  const first = render(<ForwardingSection host={host} />);
  const second = render(<ForwardingSection host={host} embedded />);
  fireEvent.click(within(second.container).getByRole("button", { name: "Add forward" }));
  fireEvent.change(within(second.container).getByLabelText("Name"), {
    target: { value: "Retain this draft" },
  });
  fireEvent.click(within(first.container).getByRole("button", { name: "Add forward" }));
  fireEvent.change(within(first.container).getByLabelText("Name"), {
    target: { value: "Saved elsewhere" },
  });
  fireEvent.click(within(first.container).getByRole("button", { name: "Save" }));
  await within(first.container).findByText("Saved elsewhere");
  expect((within(second.container).getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Retain this draft",
  );
  fireEvent.click(within(second.container).getByRole("button", { name: "Cancel" }));
  await within(second.container).findByText("Saved elsewhere");
});

it("keeps the saved rule visible with startup progress while waiting for SSH", async () => {
  connect();
  let completeStart!: () => void;
  const implementation = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_start")
      await new Promise<void>((resolve) => {
        completeStart = resolve;
      });
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.click(screen.getByRole("button", { name: "Save and start" }));
  const progress = await screen.findByRole("button", { name: "Starting…" });
  expect((progress as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("127.0.0.1:80", { selector: "strong" })).toBeTruthy();
  expect(screen.queryByText("No forwarding rules yet")).toBeNull();
  await act(async () => completeStart());
  await screen.findByText("Running");
});

it("keeps stopping feedback and actions disabled until the listener is released", async () => {
  connect();
  rows = [
    {
      id: "rule",
      hostId: "host",
      name: "Database",
      mode: "remote",
      bindHost: "127.0.0.1",
      bindPort: 8000,
      targetHost: "127.0.0.1",
      targetPort: 80,
      active: true,
      sessionId: "current",
      revision: "initial-version",
    },
  ];
  let release!: () => void;
  const implementation = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_stop") {
      rows = rows.map((row) => ({ ...row, active: false, sessionId: null }));
      domainEvents.forwardsChanged();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(
    ((await screen.findByRole("button", { name: "Stopping…" })) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Actions for Database" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByText("Stopped")).toBeNull();
  expect(screen.queryByText("Starting…")).toBeNull();
  await act(async () => release());
  await screen.findByText("Stopped");
  expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
});

const savedRule = () => ({
  id: "rule",
  hostId: "host",
  name: "Database",
  mode: "local" as const,
  bindHost: "127.0.0.1",
  bindPort: 15432,
  targetHost: "127.0.0.1",
  targetPort: 5432,
  active: false,
  sessionId: null,
  revision: "original-version",
});

it("keeps an unsaved edit when another surface changes the same rule", async () => {
  rows = [savedRule()];
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep my edit" } });
  rows = [{ ...savedRule(), name: "Saved elsewhere", revision: "new-version" }];
  act(() => domainEvents.forwardsChanged());
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed or was deleted");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Keep my edit");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_save", {
    rule: expect.objectContaining({ name: "Keep my edit" }),
    expectedRevision: "original-version",
  });
  expect(rows[0]?.name).toBe("Saved elsewhere");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByText("Saved elsewhere");
});

it("binds deletion confirmation to the version the user actually reviewed", async () => {
  rows = [savedRule()];
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  const confirmation = vi.mocked(useDialogs.getState().confirm).mock.calls.at(-1)![0];
  rows = [{ ...savedRule(), name: "Changed during confirmation", revision: "new-version" }];
  await act(async () => {
    await confirmation.onConfirm();
  });
  expect(invokeMock).toHaveBeenCalledWith("forwarding_remove", {
    id: "rule",
    expectedRevision: "original-version",
  });
  expect(rows).toHaveLength(1);
  await screen.findByText("Changed during confirmation");
});

it("does not apply a delayed exposure approval to a cancelled editor", async () => {
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Local listen address"), { target: { value: "0.0.0.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const confirmation = vi.mocked(useDialogs.getState().confirm).mock.calls.at(-1)![0];
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New draft" } });
  await act(async () => {
    await confirmation.onConfirm();
  });
  expect(invokeMock).not.toHaveBeenCalledWith("forwarding_save", expect.anything());
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("New draft");
});

it("shows a delayed deletion conflict even when the rule no longer exists", async () => {
  rows = [savedRule()];
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  const confirmation = vi.mocked(useDialogs.getState().confirm).mock.calls.at(-1)![0];
  rows = [];
  act(() => domainEvents.forwardsChanged());
  await screen.findByText("No forwarding rules yet");
  await act(async () => {
    await confirmation.onConfirm();
  });
  expect((await screen.findByRole("alert")).textContent).toContain("changed or was deleted");
  expect(rows).toHaveLength(0);
});

it("does not resurrect a rule deleted while its editor was open", async () => {
  rows = [savedRule()];
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Keep deleted draft" } });
  rows = [];
  act(() => domainEvents.forwardsChanged());
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed or was deleted");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Keep deleted draft");
  expect(rows).toHaveLength(0);
});

it("does not start a changed endpoint after the user finishes connecting", async () => {
  rows = [savedRule()];
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start" }));
  rows = [{ ...savedRule(), targetPort: 9999, revision: "new-version" }];
  fireEvent.click(screen.getByRole("button", { name: "Connect forwarding" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed or was deleted");
  expect(rows[0]?.active).toBe(false);
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "rule",
    sessionId: "forward",
    expectedRevision: "original-version",
  });
});
