import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
import "@/i18n/i18n";
import { ForwardingSection, type ForwardRule } from "@/features/forwarding/ForwardingSection";
import type { Host } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
const host = { id: "host", name: "server" } as Host;
let rows: (ForwardRule & { active: boolean; sessionId: string | null })[];
beforeEach(() => {
  rows = [];
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
  fireEvent.click(screen.getByRole("button", { name: "Direction" }));
  fireEvent.click(
    screen.getByRole("option", { name: "Remote listener → local service (share local)" }),
  );
  expect(screen.getByLabelText("Remote listen address")).toBeTruthy();
  expect(screen.getByLabelText("Local service address")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Share local app" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Share local app");
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Running");
  expect(invokeMock).toHaveBeenCalledWith("forwarding_start", { id: "rule", sessionId: "current" });
});
