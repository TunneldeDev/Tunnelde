import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, openTerminal } = vi.hoisted(() => ({
  apiMock: { sshConnect: vi.fn(), markHostUsed: vi.fn() },
  openTerminal: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));
vi.mock("@/store/workspace", () => ({ useWorkspace: { getState: () => ({ openTerminal }) } }));
import "@/i18n/i18n";
import { connectHostDirectly } from "@/lib/session/connectHost";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";

const host = { id: "h1", name: "Web", authMethod: "password" } as Host;

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.markHostUsed.mockResolvedValue(undefined);
  useDialogs.setState({ dialog: { kind: "none" } });
  useSsh.setState({ sessions: [], connectingHostId: null, connectingHostIds: [] });
});

describe("direct host connection", () => {
  it("uses backend credential and host-key checks and opens the terminal without a dialog", async () => {
    const session = { id: "s1", hostId: host.id };
    apiMock.sshConnect.mockResolvedValue(session);
    await connectHostDirectly(host);
    expect(apiMock.sshConnect).toHaveBeenCalledWith({ hostId: "h1", cols: 120, rows: 32 });
    expect(openTerminal).toHaveBeenCalledWith(session);
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });

  it.each(["ssh.hostKeyUntrusted", "ssh.hostKeyChanged", "ssh.passwordRequired", "ssh.authFailed"])(
    "falls back to the connection dialog on %s without opening a terminal",
    async (message) => {
      apiMock.sshConnect.mockRejectedValue({ code: "ssh", message });
      await connectHostDirectly(host);
      expect(useDialogs.getState().dialog).toEqual(
        expect.objectContaining({ kind: "connect", host, error: expect.any(String) }),
      );
      expect(openTerminal).not.toHaveBeenCalled();
      expect(useSsh.getState().connectingHostIds).toEqual([]);
    },
  );

  it("does not start duplicate SSH handshakes when a host is activated repeatedly", async () => {
    let resolve!: (value: unknown) => void;
    apiMock.sshConnect.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = connectHostDirectly(host);
    const second = connectHostDirectly(host);
    expect(apiMock.sshConnect).toHaveBeenCalledOnce();
    resolve({ id: "s1", hostId: "h1" });
    await Promise.all([first, second]);
    expect(useSsh.getState().connectingHostIds).toEqual([]);
  });
});
