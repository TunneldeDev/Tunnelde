import { beforeEach, expect, it, vi } from "vitest";
import { useWorkspace } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useSsh } from "@/store/ssh";
import { panelSessionIds } from "@/lib/session/panelLifecycle";
import { closeTab } from "@/lib/session/tabActions";
import type { SshSession } from "@/lib/api/types";
const { disconnect } = vi.hoisted(() => ({ disconnect: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { sshDisconnect: disconnect }, isTauri: () => false }));
const session = (id: string, purpose?: SshSession["purpose"]): SshSession => ({
  id,
  hostId: "same-host",
  title: id,
  address: "a@host:22",
  cols: 80,
  rows: 24,
  connectedAt: 0,
  terminal: true,
  ...(purpose ? { purpose } : {}),
});
beforeEach(() => {
  disconnect.mockReset().mockResolvedValue(undefined);
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useEditors.setState({ entries: {} });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
  useSsh.setState({
    sessions: [session("one"), session("two")],
    history: [],
    disconnectingSessionIds: [],
  });
});
it("defaults to disconnecting only the exact session on explicit last terminal close", async () => {
  const w = useWorkspace.getState();
  w.openTerminal(session("one"));
  w.openTerminal(session("two"));
  w.close("terminal:one");
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("one");
  await vi.waitFor(() => expect(useSsh.getState().sessions.map((s) => s.id)).toEqual(["two"]));
  expect(useWorkspace.getState().tabs.map((t) => t.id)).toEqual(["terminal:two"]);
});
it("keeps shared sessions until the last SFTP copy is closed", () => {
  const w = useWorkspace.getState();
  w.openTerminal(session("one"));
  w.openSftp(session("one"));
  w.openSftp(session("one"));
  w.close("terminal:one");
  w.close("sftp:one");
  expect(disconnect).not.toHaveBeenCalled();
  w.close(useWorkspace.getState().tabs[0]!.id);
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("one");
});
it("honors opt-out without removing sessions or touching another host panel", () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, disconnectOnPanelClose: false } });
  useWorkspace.getState().openTerminal(session("one"));
  closeTab(useWorkspace.getState().tabs[0]!);
  expect(disconnect).not.toHaveBeenCalled();
  expect(useSsh.getState().sessions).toHaveLength(2);
});
it("does not disconnect for layout moves, pane splits or closing unrelated panels", () => {
  const w = useWorkspace.getState();
  w.openTerminal(session("one"));
  w.openPage("settings");
  w.close("settings");
  w.splitTab("terminal:one", "row");
  expect(disconnect).not.toHaveBeenCalled();
});
it("does not implicitly tear down rule-owned forwarding or mount connections", () => {
  for (const purpose of ["forwarding", "mounts"] as const) {
    const s = session(purpose, purpose);
    useSsh.getState().acceptSession(s);
    useWorkspace.getState().openSftp(s);
    useWorkspace.getState().close(`sftp:${s.id}`);
  }
  expect(disconnect).not.toHaveBeenCalled();
});
it("tracks both split file sources, retaining a session still used by an editor", () => {
  const w = useWorkspace.getState();
  const files = w.openFilePane(
    { ownerSessionId: "one", source: { kind: "remote", sessionId: "one" }, path: "/" },
    "files",
  );
  w.setFileSession(files, "one", ["one", "two"]);
  useEditors.setState({ entries: { "editor:live": { sessionId: "one" } as never } });
  useWorkspace.setState((state) => ({
    tabs: [
      ...state.tabs,
      { id: "editor:live", kind: "editor", title: "live", hostId: "same-host", pinned: false },
    ],
  }));
  w.close(files);
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("two");
  w.close("editor:live");
  expect(disconnect).toHaveBeenCalledWith("one");
});
it("close-others releases shared sessions once and preserves the kept tab's connection", () => {
  const w = useWorkspace.getState();
  w.openTerminal(session("one"));
  w.openSftp(session("one"));
  w.openTerminal(session("two"));
  w.closeOthers("terminal:two");
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("one");
});
it("history tabs are metadata, not a reason to keep an orphan connection alive", () => {
  const w = useWorkspace.getState();
  w.openTerminal(session("one"));
  w.openHistory(session("one"));
  w.close("terminal:one");
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("one");
});
it("does not match sessions by a common id prefix", () => {
  expect(
    panelSessionIds({
      id: "sftp:one-more:copy:abc",
      kind: "sftp",
      title: "f",
      hostId: null,
      pinned: false,
    }),
  ).toEqual(["one-more"]);
});
it("does not release on float/redock, but closing the floating last consumer disconnects", () => {
  const w = useWorkspace.getState();
  w.openTerminal(session("one"));
  w.floatTab("terminal:one");
  expect(disconnect).not.toHaveBeenCalled();
  const floating = useWorkspace.getState().panes.find((p) => p.floating)!;
  w.dockPane(floating.id);
  expect(disconnect).not.toHaveBeenCalled();
  w.floatTab("terminal:one");
  w.close("terminal:one");
  expect(disconnect).toHaveBeenCalledExactlyOnceWith("one");
  expect(useWorkspace.getState().panes.some((p) => p.floating)).toBe(false);
});
