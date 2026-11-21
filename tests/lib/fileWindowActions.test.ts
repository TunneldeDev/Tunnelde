import { beforeEach, expect, it, vi } from "vitest";
const { api, commands, menuRun, mounts, mountReveal, pick } = vi.hoisted(() => ({
  api: {
    openLocalPath: vi.fn(),
    revealLocalPath: vi.fn(),
    clipboardWriteText: vi.fn(),
    openLatestLog: vi.fn(),
  },
  commands: vi.fn().mockReturnValue([]),
  menuRun: vi.fn(),
  mounts: vi.fn().mockResolvedValue([]),
  mountReveal: vi.fn(),
  pick: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api }));
vi.mock("@/lib/plugins/fileMenu", () => ({
  fileMenuCommands: commands,
  runFileMenuCommand: menuRun,
}));
vi.mock("@/lib/plugins/mountFileMenu", () => ({
  discoverMountedFileActions: mounts,
  revealMountedFile: mountReveal,
}));
vi.mock("@/features/sftp/fileWindowPicker", () => ({ pickFileWindowRemote: pick }));
vi.mock("@/features/sftp/fileWindowPublication", () => ({
  fileWindowViews: () => ({ "valid-key": {} }),
}));
import { executeFileWindowAction } from "@/features/sftp/fileWindowActions";
import { useFileWindowRegistrations } from "@/features/sftp/fileWindowRegistration";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useFileClipboard } from "@/store/fileClipboard";
import type { SshSession } from "@/lib/api/types";
const lease = { panelId: "files:one", windowId: "target", generation: 2 };
const remote = { kind: "remote" as const, sessionId: "ssh" };
const entry = {
  name: "file.txt",
  path: "/file.txt",
  isDir: false,
  isHidden: false,
  size: 0,
  modified: null,
  permissions: null,
};
const show = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  commands.mockReturnValue([]);
  mounts.mockResolvedValue([]);
  useWorkspace.setState({
    tabs: [{ id: lease.panelId, kind: "sftp", title: "Files", pinned: false, hostId: null }],
  });
  useSsh.setState({
    sessions: [
      {
        id: "ssh",
        hostId: "h",
        address: "qa@local:22",
        title: "QA",
        cols: 80,
        rows: 24,
      } as SshSession,
    ],
  });
  useFileWindowRegistrations.setState({
    entries: new Map([
      [
        lease.panelId,
        { sources: [{ kind: "local" }, remote], sessions: useSsh.getState().sessions, encoded: "" },
      ],
    ]),
  });
  useFileClipboard.getState().set(null);
});
it("requires a live acknowledged file tab before any owner effect", async () => {
  useFileWindowRegistrations.setState({ entries: new Map() });
  await expect(
    executeFileWindowAction(lease, { operation: "openLocal", data: { path: "/safe" } }, show),
  ).rejects.toThrow("staleOwner");
  expect(api.openLocalPath).not.toHaveBeenCalled();
});
it("rejects unbound and dedicated sessions before opening editor or showing main", async () => {
  await expect(
    executeFileWindowAction(
      lease,
      {
        operation: "editor",
        data: { source: { kind: "remote", sessionId: "unbound" }, path: "/file" },
      },
      show,
    ),
  ).rejects.toThrow("staleOwner");
  useSsh.setState({
    sessions: useSsh.getState().sessions.map((s) => ({ ...s, purpose: "forwarding" })),
  });
  await expect(
    executeFileWindowAction(
      lease,
      { operation: "editor", data: { source: remote, path: "/file" } },
      show,
    ),
  ).rejects.toThrow("staleOwner");
  expect(show).not.toHaveBeenCalled();
});
it("opens native file editor requests through the main workspace without reconnecting", async () => {
  await executeFileWindowAction(
    lease,
    { operation: "editor", data: { source: remote, path: "/file.txt" } },
    show,
  );
  expect(show).toHaveBeenCalledOnce();
  expect(
    useWorkspace
      .getState()
      .tabs.some((t) => t.kind === "editor" && t.id === "editor:ssh:/file.txt"),
  ).toBe(true);
});
it("rediscovers plugin menu authority rather than executing a supplied stale fingerprint", async () => {
  const action = {
    pluginId: "p",
    pluginName: "P",
    command: "inspect",
    fingerprint: "old",
    title: "Inspect",
    first: true,
  };
  commands.mockReturnValue([{ ...action, fingerprint: "new" }]);
  await expect(
    executeFileWindowAction(
      lease,
      { operation: "menuRun", data: { source: remote, entry, action } },
      show,
    ),
  ).rejects.toThrow("staleOwner");
  expect(menuRun).not.toHaveBeenCalled();
  commands.mockReturnValue([action]);
  await executeFileWindowAction(
    lease,
    { operation: "menuRun", data: { source: remote, entry, action } },
    show,
  );
  expect(menuRun).toHaveBeenCalledWith(action, remote, entry);
});
it("does not accept a forged local launch path or foreign clipboard source", async () => {
  await expect(
    executeFileWindowAction(lease, { operation: "openLocal", data: { path: "bad\0path" } }, show),
  ).rejects.toThrow("staleOwner");
  await expect(
    executeFileWindowAction(
      lease,
      {
        operation: "clip",
        data: {
          clip: { action: "cut", source: { kind: "remote", sessionId: "other" }, items: [entry] },
        },
      },
      show,
    ),
  ).rejects.toThrow("staleOwner");
  expect(api.openLocalPath).not.toHaveBeenCalled();
  expect(useFileClipboard.getState().clip).toBeNull();
});
it("normalizes search root ownership to the acknowledged file panel", async () => {
  await executeFileWindowAction(
    lease,
    {
      operation: "roots",
      data: { roots: [{ id: "root", tabId: "forged", path: "/", sessionId: "ssh" }] },
    },
    show,
  );
  const { useSearchRoots } = await import("@/store/searchRoots");
  expect(
    Object.values(useSearchRoots.getState().roots)
      .flat()
      .some((r) => r.tabId === lease.panelId && r.path === "/"),
  ).toBe(true);
});
