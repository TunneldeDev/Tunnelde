import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { disconnect } = vi.hoisted(() => ({ disconnect: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { sshDisconnect: disconnect } }));
import i18n from "@/i18n/i18n";
import { ConnectionStatus } from "@/components/layout/ConnectionStatus";
import { useSsh } from "@/store/ssh";
import type { SshSession } from "@/lib/api/types";

const session = (id: string, extra: Partial<SshSession> = {}): SshSession => ({
  id,
  hostId: "host",
  title: "Server",
  address: "qa@example.test:2222",
  cols: 80,
  rows: 24,
  connectedAt: 1700000000000,
  terminal: true,
  ...extra,
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  disconnect.mockReset().mockResolvedValue(undefined);
  useSsh.setState({ sessions: [], history: [], disconnectingSessionIds: [] });
});
it("opens the empty session list and closes using Escape with focus restored", () => {
  render(<ConnectionStatus />);
  const trigger = screen.getByRole("button", { name: "0 connections" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Connection details" });
  expect(within(dialog).getByText("0 active sessions")).toBeTruthy();
  expect(within(dialog).getByText("No active connections")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("shows real endpoints, identities and purposes, updating while the dialog is open", () => {
  useSsh.setState({
    sessions: [
      session("terminal"),
      session("forward", { terminal: false, purpose: "forwarding" }),
      session("background", { terminal: false }),
    ],
  });
  render(<ConnectionStatus />);
  fireEvent.click(screen.getByRole("button", { name: "3 connections" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("3 active sessions")).toBeTruthy();
  expect(within(dialog).getByText("Terminal · Connected")).toBeTruthy();
  expect(within(dialog).getByText("Port forwarding · Connected")).toBeTruthy();
  expect(within(dialog).getByText("Background · Connected")).toBeTruthy();
  for (const summary of dialog.querySelectorAll("summary")) fireEvent.click(summary);
  expect(within(dialog).getAllByText("qa@example.test:2222")).toHaveLength(6);
  expect(within(dialog).getByText("forward")).toBeTruthy();
  // A saved host can change after connecting; details must keep the live endpoint.
  act(() =>
    useSsh.setState({ sessions: [session("replacement", { address: "other@new.test:22" })] }),
  );
  expect(screen.getByRole("button", { name: "1 connection" })).toBeTruthy();
  expect(within(dialog).getByText("1 active session")).toBeTruthy();
  expect(within(dialog).getAllByText("other@new.test:22")).toHaveLength(2);
  expect(within(dialog).queryByText("forward")).toBeNull();
  act(() => useSsh.setState({ sessions: [] }));
  expect(within(dialog).getByText("No active connections")).toBeTruthy();
});

it("cancels or confirms closure of only the selected session and retains its actual history", async () => {
  useSsh.getState().acceptSession(session("first"));
  useSsh.getState().acceptSession(session("second", { purpose: "forwarding", terminal: false }));
  render(<ConnectionStatus />);
  fireEvent.click(screen.getByRole("button", { name: "2 connections" }));
  const row = screen.getByRole("listitem", { name: "Server · second" });
  fireEvent.click(within(row).getByRole("button", { name: "Close session" }));
  expect(within(row).getByText(/Other sessions are not affected/)).toBeTruthy();
  expect(disconnect).not.toHaveBeenCalled();
  fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
  expect(within(row).queryByRole("button", { name: "Confirm close" })).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Close session" }));
  fireEvent.click(within(row).getByRole("button", { name: "Confirm close" }));
  await waitFor(() => expect(disconnect).toHaveBeenCalledExactlyOnceWith("second"));
  await waitFor(() => expect(screen.getByRole("button", { name: "1 connection" })).toBeTruthy());
  const recent = screen.getByText("Recently ended").closest("details")!;
  fireEvent.click(recent.querySelector("summary")!);
  const endedRow = within(recent).getByRole("listitem", { name: "Server · second" });
  fireEvent.click(endedRow.querySelector("summary")!);
  expect(within(endedRow).getByText("Close requested")).toBeTruthy();
  expect(within(endedRow).getByText("Session ended")).toBeTruthy();
  expect(within(endedRow).queryByRole("button", { name: "Close session" })).toBeNull();
  expect(useSsh.getState().sessions.map((s) => s.id)).toEqual(["first"]);
});

it("disables repeat closure while pending, retains failed sessions and exposes failure details", async () => {
  let reject!: (error: Error) => void;
  disconnect.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  useSsh.getState().acceptSession(session("pending"));
  render(<ConnectionStatus />);
  fireEvent.click(screen.getByRole("button", { name: "1 connection" }));
  fireEvent.click(screen.getByRole("button", { name: "Close session" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
  expect(
    screen
      .getAllByRole("button", { name: "Closing…" })
      .every((b) => (b as HTMLButtonElement).disabled),
  ).toBe(true);
  await act(async () => reject(new Error("Transport busy")));
  expect(useSsh.getState().sessions).toHaveLength(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Session details").closest("summary")!);
  expect(screen.getByText("Close failed")).toBeTruthy();
  expect(screen.getByText("Transport busy")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close session" })).toBeTruthy();
});

it("moves a remotely closed session to recent history while its confirmation is open", () => {
  useSsh.getState().acceptSession(session("gone"));
  render(<ConnectionStatus />);
  fireEvent.click(screen.getByRole("button", { name: "1 connection" }));
  fireEvent.click(screen.getByRole("button", { name: "Close session" }));
  act(() => useSsh.getState().forget("gone", "closed"));
  expect(screen.queryByRole("button", { name: "Confirm close" })).toBeNull();
  expect(screen.getByText("No active connections")).toBeTruthy();
  expect(useSsh.getState().history[0]!.events.at(-1)).toMatchObject({
    kind: "ended",
    detail: "closed",
  });
  expect(disconnect).not.toHaveBeenCalled();
});
