import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
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
  useSsh.setState({ sessions: [] });
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
  expect(within(dialog).getByText("Terminal")).toBeTruthy();
  expect(within(dialog).getByText("Port forwarding")).toBeTruthy();
  expect(within(dialog).getByText("Background")).toBeTruthy();
  expect(within(dialog).getAllByText("qa@example.test:2222")).toHaveLength(3);
  expect(within(dialog).getByText("forward")).toBeTruthy();
  // A saved host can change after connecting; details must keep the live endpoint.
  act(() =>
    useSsh.setState({ sessions: [session("replacement", { address: "other@new.test:22" })] }),
  );
  expect(screen.getByRole("button", { name: "1 connection" })).toBeTruthy();
  expect(within(dialog).getByText("1 active session")).toBeTruthy();
  expect(within(dialog).getByText("other@new.test:22")).toBeTruthy();
  expect(within(dialog).queryByText("forward")).toBeNull();
  act(() => useSsh.setState({ sessions: [] }));
  expect(within(dialog).getByText("No active connections")).toBeTruthy();
});
