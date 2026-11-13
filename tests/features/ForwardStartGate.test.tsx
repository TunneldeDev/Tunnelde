import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host } from "@/lib/api/types";
import i18n from "@/i18n/i18n";
import { prepareWindowReload } from "@/lib/session/reload";
import type { PendingForwardStart } from "@/features/forwarding/start/api";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true }));
vi.mock("@/features/connect/ConnectDialog", () => ({
  ConnectDialog: (props: { host: Host; context: React.ReactNode; onClose: () => void }) => (
    <div role="dialog">
      <span>{props.host.name}</span>
      {props.context}
      <button onClick={props.onClose}>Cancel startup</button>
    </div>
  ),
}));
import { ForwardStartGate } from "@/features/forwarding/start/ForwardStartGate";
import { forwardStartConnection } from "@/features/forwarding/start/api";

const pending: PendingForwardStart = {
  receipt: {
    id: "rule",
    revision: "revision",
    requestId: "request",
    phase: "credentials",
    expiresAt: 1_800_000_000_000,
  },
  host: { id: "host", name: "Captured server" } as Host,
  jumpHosts: [{ id: "jump", name: "Captured jump" } as Host],
  rule: {
    id: "rule",
    hostId: "host",
    name: "Database",
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 15432,
    targetHost: "127.0.0.1",
    targetPort: 5432,
  },
};
beforeEach(async () => {
  vi.clearAllMocks();
  mock.invoke.mockResolvedValue(null);
  mock.listen.mockResolvedValue(mock.unlisten);
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  vi.useRealTimers();
});

it("queries pending requests without needing an event, shows captured endpoints, and cancels the exact request", async () => {
  mock.invoke.mockResolvedValue(pending);
  render(<ForwardStartGate />);
  await screen.findByRole("dialog");
  expect(screen.getByText("Captured server")).toBeTruthy();
  expect(screen.getByText(/15432.*5432/)).toBeTruthy();
  expect(mock.invoke).toHaveBeenCalledWith("forwarding_start_pending", {
    uiId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel startup" }));
  expect(mock.invoke).toHaveBeenCalledWith("forwarding_start_cancel", { requestId: "request" });
});

it("handles a native event and releases the document lease before the actual application reload", async () => {
  render(<ForwardStartGate />);
  await waitFor(() => expect(mock.listen).toHaveBeenCalledOnce());
  const refresh = mock.listen.mock.calls[0]![1];
  await act(async () => {
    mock.invoke.mockResolvedValueOnce(pending);
    refresh();
  });
  await screen.findByRole("dialog");
  const owner = mock.invoke.mock.calls.find(([name]) => name === "forwarding_start_pending")![1];
  await act(async () => {
    await prepareWindowReload();
  });
  expect(mock.invoke).toHaveBeenCalledWith("forwarding_start_release_ui", owner);
  expect(mock.unlisten).toHaveBeenCalledOnce();
});

it("a pending query started before closing cannot reopen the dismissed dialog", async () => {
  mock.invoke.mockResolvedValue(pending);
  render(<ForwardStartGate />);
  await screen.findByRole("dialog");
  let finish!: (value: PendingForwardStart) => void;
  mock.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    mock.listen.mock.calls[0]![1]();
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel startup" }));
  await act(async () => {
    finish(pending);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("polls missed events and closes an externally cancelled or completed request", async () => {
  vi.useFakeTimers();
  render(<ForwardStartGate />);
  await act(async () => {
    await Promise.resolve();
  });
  mock.invoke.mockResolvedValue(pending);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole("dialog")).toBeTruthy();
  mock.invoke.mockResolvedValue(null);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses only request-owned native operations and the captured jump list", async () => {
  const connection = forwardStartConnection(pending, "document");
  const scope = { requestId: "request", uiId: "document" };
  expect(connection.verification.jumpHosts).toBe(pending.jumpHosts);
  await connection.verification.probe({ jump: { password: "fixture-only" } });
  await connection.verification.trust("fingerprint", {}, "jump");
  await connection.connect({ hostId: "host", password: "fixture-only" });
  expect(mock.invoke.mock.calls).toEqual([
    ["forwarding_start_probe", { ...scope, credentials: { jump: { password: "fixture-only" } } }],
    [
      "forwarding_start_trust",
      { ...scope, fingerprint: "fingerprint", expectedHostId: "jump", credentials: {} },
    ],
    [
      "forwarding_start_connect",
      { ...scope, request: { hostId: "host", password: "fixture-only" } },
    ],
  ]);
});
