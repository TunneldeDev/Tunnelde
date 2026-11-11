import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshSession } from "@/lib/api/types";

const { apiMock, closeSession, forgetMonitor } = vi.hoisted(() => ({
  apiMock: {
    sshConnect: vi.fn(),
    sshDisconnect: vi.fn(),
    sshSessions: vi.fn(),
    markHostUsed: vi.fn(),
  },
  closeSession: vi.fn(),
  forgetMonitor: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));
vi.mock("@/store/workspace", () => ({ useWorkspace: { getState: () => ({ closeSession }) } }));
vi.mock("@/store/monitor", () => ({ useMonitor: { getState: () => ({ forget: forgetMonitor }) } }));
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
  it("publishes a native-accepted session synchronously and fences an older refresh", async () => {
    let resolveSnapshot!: (sessions: SshSession[]) => void;
    apiMock.sshSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const old = useSsh.getState().refresh();
    const accepted = { ...session, id: "native-accepted", terminal: false };
    useSsh.getState().acceptSession(accepted);
    expect(useSsh.getState().sessions).toContainEqual(accepted);
    useSsh.getState().acceptSession({ ...accepted, title: "Updated" });
    expect(useSsh.getState().sessions.filter((item) => item.id === accepted.id)).toHaveLength(1);
    resolveSnapshot([]);
    await old;
    expect(useSsh.getState().sessions.find((item) => item.id === accepted.id)?.title).toBe(
      "Updated",
    );
    expect(closeSession).not.toHaveBeenCalled();
  });
  it("reconciles missed close notifications from an authoritative session snapshot", async () => {
    const connected = { ...session, id: "still-connected" };
    useSsh.setState({ sessions: [session, connected] });
    apiMock.sshSessions.mockResolvedValue([connected]);
    await useSsh.getState().refresh();
    expect(useSsh.getState().sessions).toEqual([connected]);
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(forgetMonitor).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
  });

  it("does not resurrect sessions from a slower, older refresh", async () => {
    let resolveOld!: (sessions: SshSession[]) => void;
    apiMock.sshSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const old = useSsh.getState().refresh();
    apiMock.sshSessions.mockResolvedValueOnce([]);
    await useSsh.getState().refresh();
    resolveOld([session]);
    await old;
    expect(useSsh.getState().sessions).toEqual([]);
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it("updates all connection titles after renaming a host and ignores an older refresh", async () => {
    let resolveSnapshot!: (sessions: SshSession[]) => void;
    const others = { ...session, id: "other-host", hostId: "other", title: "Other" };
    useSsh.setState({ sessions: [session, { ...session, id: "second" }, others] });
    apiMock.sshSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const refresh = useSsh.getState().refresh();
    useSsh.getState().renameHost(session.hostId, "Temporary name");
    useSsh.getState().renameHost(session.hostId, "server");
    resolveSnapshot([{ ...session, title: "Temporary name" }]);
    await refresh;
    expect(useSsh.getState().sessions.map((item) => [item.id, item.title])).toEqual([
      [session.id, "server"],
      ["second", "server"],
      [others.id, "Other"],
    ]);
    expect(apiMock.sshConnect).not.toHaveBeenCalled();
    expect(apiMock.sshDisconnect).not.toHaveBeenCalled();
  });
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
