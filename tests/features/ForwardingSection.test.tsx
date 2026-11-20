import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: { sshDisconnect: async () => {} } }));
vi.mock("@/features/connect/ConnectDialog", () => ({
  ConnectDialog: ({
    onConnected,
    onClose,
    connectSession,
  }: {
    onConnected: (session: unknown) => void;
    onClose: () => void;
    connectSession: (request: unknown, review?: unknown) => Promise<unknown>;
  }) => {
    const [error, setError] = useState<string | null>(null);
    return (
      <>
        <button
          onClick={() => {
            void connectSession(
              { hostId: "host", password: "test-password" },
              { hostId: "host", revision: "review" },
            )
              .then((session) => {
                onConnected(session);
                onClose();
              })
              .catch((cause) => setError(translateError(cause)));
          }}
        >
          Connect forwarding
        </button>
        {error && <p role="alert">{error}</p>}
      </>
    );
  },
}));
import { useState } from "react";
import { translateError } from "@/lib/api/errors";
import "@/i18n/i18n";
import { ForwardingSection } from "@/features/forwarding/ForwardingSection";
import type { ForwardInfo } from "@/features/forwarding/model/contract";
import type { Host } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import { domainEvents } from "@/lib/events/domain";
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session/clipboard", () => ({ copyText: copyMock }));
const host = { id: "host", name: "server" } as Host;
let rows: ForwardInfo[];
beforeEach(() => {
  rows = [];
  copyMock.mockReset();
  invokeMock.mockReset().mockImplementation(async (command, args) => {
    if (command === "forwarding_list") return rows;
    if (command === "forwarding_groups_list") return [];
    if (command === "forwarding_save") {
      if (
        args.expectedRevision &&
        rows.find((row) => row.id === args.rule.id)?.revision !== args.expectedRevision
      )
        throw { code: "validation", message: "forward.changed" };
      rows = [
        {
          ...args.rule,
          groupId: args.groupId ?? null,
          id: "rule",
          active: false,
          sessionId: null,
          revision: crypto.randomUUID(),
        },
      ];
      return rows[0];
    }
    if (command === "forwarding_start_managed") {
      if (
        args.expectedRevision &&
        rows.find((row) => row.id === args.id)?.revision !== args.expectedRevision
      )
        throw { code: "validation", message: "forward.changed" };
      if (
        !args.request &&
        !useSsh.getState().sessions.some((session) => session.purpose === "forwarding")
      )
        throw { code: "ssh", message: "ssh.passwordRequired" };
      const rule = rows.find((row) => row.id === args.id)!;
      const sessionId = `managed-${rule.groupId ?? rule.id}`;
      rows = rows.map((r) => (r.id === args.id ? { ...r, active: true, sessionId } : r));
      return {
        id: sessionId,
        hostId: "host",
        title: "server",
        address: "server:22",
        cols: 80,
        rows: 24,
        connectedAt: 0,
        purpose: "forwarding",
      };
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
it("starts ungrouped rules through managed isolated connections and clears stale status after disconnect", async () => {
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
  fireEvent.click(await screen.findByRole("button", { name: "Connect forwarding" }));
  await waitFor(() => expect(screen.getAllByText("Running")).toHaveLength(2));
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "one",
      expectedRevision: "initial-version",
    }),
  );
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "two",
      expectedRevision: "initial-version",
    }),
  );
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
    if (command === "forwarding_start_managed" && args.id === "one")
      throw new Error("Port occupied");
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start all" }));
  expect((await screen.findByRole("alert")).textContent).toContain("one: Port occupied");
  expect(screen.getByText("Running")).toBeTruthy();
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "two",
      expectedRevision: "initial-version",
    }),
  );
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
  fireEvent.click(await screen.findByRole("button", { name: "Connect forwarding" }));
  expect(invokeMock).toHaveBeenCalledWith("forwarding_save", {
    groupId: null,
    assignGroup: true,
    rule: expect.objectContaining({
      hostId: "host",
      bindHost: "127.0.0.1",
      targetHost: "127.0.0.1",
    }),
  });
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "rule",
      expectedRevision: expect.any(String),
    }),
  );
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
  fireEvent.click(await screen.findByRole("button", { name: "Connect forwarding" }));
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "rule",
      expectedRevision: expect.any(String),
    }),
  );
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
    groupId: null,
    assignGroup: true,
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
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "rule",
      expectedRevision: expect.any(String),
    }),
  );
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
    if (command === "forwarding_start_managed" && failStart)
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
    if (command === "forwarding_start_managed")
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
    groupId: null,
    assignGroup: true,
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

it("retires the editor and its pending approval when the host changes", async () => {
  const view = render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Local listen address"), { target: { value: "0.0.0.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const confirmation = vi.mocked(useDialogs.getState().confirm).mock.calls.at(-1)![0];
  view.rerender(<ForwardingSection host={{ ...host, id: "other", name: "Other host" }} />);
  await act(async () => {
    await confirmation.onConfirm();
  });
  expect(invokeMock).not.toHaveBeenCalledWith("forwarding_save", expect.anything());
  expect(screen.queryByRole("form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  expect((screen.getByLabelText("Local listen address") as HTMLInputElement).value).toBe(
    "127.0.0.1",
  );
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
  await screen.findByRole("button", { name: "Connect forwarding" });
  rows = [{ ...savedRule(), targetPort: 9999, revision: "new-version" }];
  fireEvent.click(await screen.findByRole("button", { name: "Connect forwarding" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed or was deleted");
  expect(rows[0]?.active).toBe(false);
  expect(invokeMock).toHaveBeenCalledWith(
    "forwarding_start_managed",
    expect.objectContaining({
      id: "rule",
      expectedRevision: "original-version",
    }),
  );
});

it("saves independent automation preferences outside the stable rule payload and preserves them on edit", async () => {
  rows = [{ ...savedRule(), automation: { autoStart: true, autoRetry: false } }];
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Database" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(
    screen.getByRole("switch", { name: "Start when the app opens" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("switch", { name: "Retry automatically" }).getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("switch", { name: "Retry automatically" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("forwarding_save", {
      groupId: null,
      assignGroup: true,
      rule: forwardingRuleWithoutAutomation(),
      expectedRevision: "original-version",
      automation: { autoStart: true, autoRetry: true },
    }),
  );
});

function forwardingRuleWithoutAutomation() {
  const { active: _active, sessionId: _session, revision: _revision, ...rule } = savedRule();
  return rule;
}

it("allows stopping automatic retries even when no SSH connection is active", async () => {
  rows = [
    {
      ...savedRule(),
      automation: { autoStart: false, autoRetry: true },
      automationStatus: {
        phase: "retrying",
        retryAt: Date.now() + 2000,
        error: { code: "ssh", message: "ssh.timeout" },
      },
    },
  ];
  render(<ForwardingSection host={host} />);
  expect(await screen.findByText("Waiting to retry")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start all" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("forwarding_stop", { id: "rule" }));
  expect(screen.queryByRole("button", { name: "Connect forwarding" })).toBeNull();
});

it("shows startup only on the current rule and leaves automatic retries alone in a group batch", async () => {
  connect();
  rows = ["one", "two", "retry", "other"].map((id) => ({
    ...savedRule(),
    id,
    name: id,
    groupId: id === "other" ? null : "services",
    ...(id === "retry"
      ? {
          automationStatus: { phase: "retrying" as const, retryAt: Date.now() + 2000, error: null },
        }
      : {}),
  }));
  const implementation = invokeMock.getMockImplementation()!;
  let release!: () => void;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_groups_list")
      return [{ id: "services", name: "Services", hostId: "host", revision: "g1" }];
    if (command === "forwarding_start_managed" && args.id === "one")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  const region = await screen.findByRole("region", { name: "Services" });
  fireEvent.click(within(region).getByRole("button", { name: /start.*services/i }));
  await within(region).findByText("Starting…");
  expect(within(region).getByText("Waiting to retry")).toBeTruthy();
  expect(within(region).getByText("Stopped")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "Ungrouped" })).getByText("Stopped"),
  ).toBeTruthy();
  await act(async () => release());
  await waitFor(() => expect(within(region).getAllByText("Running")).toHaveLength(2));
  expect(
    invokeMock.mock.calls
      .filter(([cmd]) => cmd === "forwarding_start_managed")
      .map(([, args]) => args.id),
  ).toEqual(["one", "two"]);
});

it("disconnects only the confirmed forwarding connections, preserving newer and terminal sessions", async () => {
  const connection = {
    hostId: "host",
    title: "server",
    address: "qa@server:22",
    cols: 80,
    rows: 24,
    connectedAt: 1,
  };
  useSsh.setState({
    sessions: [
      { ...connection, id: "one", purpose: "forwarding" },
      { ...connection, id: "two", purpose: "forwarding" },
      { ...connection, id: "terminal", terminal: true },
    ],
  });
  render(<ForwardingSection host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  const confirmMock = useDialogs.getState().confirm as ReturnType<typeof vi.fn>;
  expect(confirmMock.mock.calls[0]![0].body).toContain("2 forwarding connections on server");
  act(() =>
    useSsh.setState((state) => ({
      sessions: [...state.sessions, { ...connection, id: "later", purpose: "forwarding" }],
    })),
  );
  await act(async () => confirmMock.mock.calls[0]![0].onConfirm());
  expect(useSsh.getState().sessions.map((session) => session.id)).toEqual(["terminal", "later"]);
});

it("saves a rule into the selected group and shows it under that group", async () => {
  const implementation = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_groups_list")
      return [{ id: "shared", hostId: "host", name: "Services", revision: "group-v1" }];
    return implementation(command, args);
  });
  render(<ForwardingSection host={host} />);
  await screen.findByRole("region", { name: "Services" });
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Database" } });
  fireEvent.click(screen.getByRole("button", { name: "Forwarding group" }));
  fireEvent.click(screen.getByRole("option", { name: "Services" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(
      "forwarding_save",
      expect.objectContaining({ groupId: "shared", assignGroup: true }),
    ),
  );
  const group = await screen.findByRole("region", { name: "Services" });
  expect(within(group).getByRole("heading", { name: "Services", level: 3 }).className).toBe(
    "forward-group__title",
  );
  const rule = within(group).getByText("Database");
  expect(rule.closest(".forward-rules")?.parentElement).toBe(group);
  expect(rule.closest("h3")).toBeNull();
  expect(screen.queryByRole("region", { name: "Ungrouped" })).toBeNull();
});

it("keeps Add forwarding and New group adjacent and preserves group creation/revision rename", async () => {
  let groups: { id: string; hostId: string; name: string; revision: string }[] = [];
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "forwarding_list") return [];
    if (command === "forwarding_groups_list") return groups;
    if (command === "forwarding_group_save") {
      groups = [{ id: args.id ?? "created", hostId: args.hostId, name: args.name, revision: "g2" }];
      return groups[0];
    }
  });
  render(<ForwardingSection host={host} />);
  const add = await screen.findByRole("button", { name: "Add forward" });
  const create = screen.getByRole("button", { name: "New forwarding group" });
  expect(create.parentElement).toBe(add.parentElement);
  expect(add.nextElementSibling).toBe(create);
  await waitFor(() => expect(create).toHaveProperty("disabled", false));
  fireEvent.click(create);
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Services" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("region", { name: "Services" });
  expect(invokeMock).toHaveBeenCalledWith("forwarding_group_save", {
    hostId: "host",
    name: "Services",
  });
  fireEvent.click(
    within(screen.getByRole("region", { name: "Services" })).getByRole("button", { name: "More" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Databases" },
  });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Group name" }), { key: "Enter" });
  await screen.findByRole("region", { name: "Databases" });
  expect(invokeMock).toHaveBeenCalledWith("forwarding_group_save", {
    hostId: "host",
    id: "created",
    name: "Databases",
    expectedRevision: "g2",
  });
});

it("shares one group snapshot across host surfaces and keeps empty groups host-scoped", async () => {
  const implementation = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((command, args) =>
    command === "forwarding_groups_list"
      ? Promise.resolve([
          { id: "one-group", hostId: "host", name: "First empty group", revision: "one" },
          { id: "two-group", hostId: "other", name: "Second empty group", revision: "two" },
        ])
      : implementation(command, args),
  );
  const view = render(
    <>
      <ForwardingSection host={host} />
      <ForwardingSection host={{ ...host, id: "other", name: "Other" }} />
    </>,
  );
  const first = await screen.findByRole("region", { name: "First empty group" });
  const second = await screen.findByRole("region", { name: "Second empty group" });
  expect(first.closest(".forwarding")).not.toBe(second.closest(".forwarding"));
  expect(
    within(first.closest(".forwarding") as HTMLElement).queryByRole("region", {
      name: "Second empty group",
    }),
  ).toBeNull();
  expect(
    invokeMock.mock.calls.filter(([command]) => command === "forwarding_groups_list"),
  ).toHaveLength(1);
  view.unmount();
  render(<ForwardingSection host={host} />);
  await screen.findByRole("region", { name: "First empty group" });
  expect(
    invokeMock.mock.calls.filter(([command]) => command === "forwarding_groups_list"),
  ).toHaveLength(2);
});

it("invalidates provider frames immediately when a local rule, group or session source changes before React commits", async () => {
  const { useForwardingController } =
    await import("@/features/forwarding/runtime/useForwardingController");
  const { forwardingStore } = await import("@/features/forwarding/data/store");
  const { forwardingGroupsStore } = await import("@/features/forwarding/data/groups");
  const hook = renderHook(() => useForwardingController(host));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.validate()).toBe(true);
  const ruleFrame = hook.result.current;
  await act(async () => {
    forwardingStore.accept((entries) => [...entries]);
    expect(ruleFrame.validate()).toBe(false);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.validate()).toBe(true));
  const groupFrame = hook.result.current;
  await act(async () => {
    forwardingGroupsStore.accept((entries) => [...entries]);
    expect(groupFrame.validate()).toBe(false);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  await waitFor(() => expect(hook.result.current.validate()).toBe(true));
  const sessionFrame = hook.result.current;
  await act(async () => {
    useSsh.setState({ sessions: [] });
    expect(sessionFrame.validate()).toBe(false);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
});
