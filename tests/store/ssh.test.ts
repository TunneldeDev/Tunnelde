// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshSession } from "@/lib/api/types";

const { apiMock, closeSession } = vi.hoisted(() => ({
  apiMock: {
    sshConnect: vi.fn(),
    sshDisconnect: vi.fn(),
    sshSessions: vi.fn(),
    markHostUsed: vi.fn(),
  },
  closeSession: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));
vi.mock("@/store/workspace", () => ({ useWorkspace: { getState: () => ({ closeSession }) } }));
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));
import { useSsh } from "@/store/ssh";

const session: SshSession = {
  id: "ssh-1",
  hostId: "host-1",
  title: "server",
  address: "user@server:22",
  cols: 80,
  rows: 24,
  connectedAt: 0,
};
const request = { hostId: "host-1", password: null, passphrase: null, cols: 80, rows: 24 };

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.markHostUsed.mockResolvedValue(undefined);
  useSsh.setState({
    sessions: [session],
    connectingHostId: null,
    connectingHostIds: [],
    disconnectingSessionIds: [],
  });
});

describe("SSH session lifecycle", () => {
  it("retains the session and tabs when disconnect fails", async () => {
    apiMock.sshDisconnect.mockRejectedValue(new Error("unavailable"));
    await useSsh.getState().disconnect(session.id);
    expect(useSsh.getState().sessions).toEqual([session]);
    expect(closeSession).not.toHaveBeenCalled();
    expect(useSsh.getState().disconnectingSessionIds).toEqual([]);
  });

  it("coalesces duplicate connections without clearing another host's pending state", async () => {
    let completeFirst!: (session: SshSession) => void;
    let completeSecond!: (session: SshSession) => void;
    apiMock.sshConnect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeSecond = resolve;
          }),
      );
    const first = useSsh.getState().connect(request);
    const duplicate = useSsh.getState().connect(request);
    const second = useSsh.getState().connect({ ...request, hostId: "host-2" });
    expect(first).toBe(duplicate);
    expect(apiMock.sshConnect).toHaveBeenCalledTimes(2);
    completeFirst(session);
    await first;
    expect(useSsh.getState().connectingHostIds).toEqual(["host-2"]);
    completeSecond({ ...session, id: "ssh-2", hostId: "host-2" });
    await second;
    expect(useSsh.getState().connectingHostIds).toEqual([]);
    expect(useSsh.getState().sessions).toHaveLength(2);
  });

  it("ignores a stale session snapshot after a successful connection", async () => {
    let resolveSnapshot!: (sessions: SshSession[]) => void;
    apiMock.sshSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const refresh = useSsh.getState().refresh();
    apiMock.sshConnect.mockResolvedValue({ ...session, id: "new-session" });
    await useSsh.getState().connect(request);
    resolveSnapshot([]);
    await refresh;
    expect(useSsh.getState().sessions.some((item) => item.id === "new-session")).toBe(true);
  });
});
