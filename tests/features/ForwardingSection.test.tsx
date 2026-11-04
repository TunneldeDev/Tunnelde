import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
import "@/i18n/i18n";
import { ForwardingSection, type ForwardRule } from "@/features/forwarding/ForwardingSection";
import type { Host } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
const copyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session/clipboard", () => ({ copyText: copyMock }));
const host = { id: "host", name: "server" } as Host;
let rows: (ForwardRule & { active: boolean; sessionId: string | null })[];
beforeEach(() => {
  rows = [];
  copyMock.mockReset();
  invokeMock.mockReset().mockImplementation(async (command, args) => {
    if (command === "forwarding_list") return rows;
    if (command === "forwarding_save") {
      rows = [{ ...args.rule, id: "rule", active: false, sessionId: null }];
      return rows[0];
    }
    if (command === "forwarding_start") {
      rows = rows.map((r) => ({ ...r, active: true, sessionId: args.sessionId }));
    }
    if (command === "forwarding_stop") {
      rows = rows.map((r) => ({ ...r, active: false, sessionId: null }));
    }
  });
  useSsh.setState({ sessions: [] });
  useDialogs.setState({ confirm: vi.fn(), openConnect: vi.fn() });
});
it("saves reusable rules, requires a connection, then starts and stops without manual session configuration", async () => {
  await act(async () => {
    render(<ForwardingSection host={host} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Database" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Database");
  expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  expect(invokeMock).toHaveBeenCalledWith("forwarding_save", {
    rule: expect.objectContaining({
      hostId: "host",
      bindHost: "127.0.0.1",
      targetHost: "127.0.0.1",
    }),
  });
  await act(async () => {
    useSsh.setState({
      sessions: [
        {
          id: "connected",
          hostId: "host",
          title: "server",
          address: "user@server:22",
          cols: 80,
          rows: 24,
          connectedAt: 1,
        },
      ],
    });
  });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", {
    id: "rule",
    sessionId: "connected",
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

it("explains endpoint ownership when changing direction and starts in the originating terminal session", async () => {
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
    render(<ForwardingSection host={host} initialSessionId="current" />);
  });
  expect(screen.getByRole("button", { name: "SSH session" }).textContent).toContain("current");
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
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", { id: "rule", sessionId: "current" });
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
      },
    ],
  });

it("offers connecting even with no saved rules, and keeps the editor separate from the list", async () => {
  render(<ForwardingSection host={host} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(useDialogs.getState().openConnect).toHaveBeenCalledWith(host);
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  expect(screen.queryByRole("button", { name: "Save and start" })).toBeNull();
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
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", { id: "rule", sessionId: "current" });
  expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "forwarding_save")).toHaveLength(1);
  expect(screen.getByText("Connect your application to 127.0.0.1:15432")).toBeTruthy();
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
