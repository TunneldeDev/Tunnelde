import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { useWorkspace } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { useStorage } from "@/store/storage";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useMarketplace } from "@/store/marketplace";
import { useSettingsProfiles } from "@/store/settingsProfiles";
import { useTransferPanel } from "@/store/transferPanel";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import {
  decodeViewSnapshot,
  encodeViewSnapshot,
  restoreViewState,
  viewStateSnapshot,
} from "@/lib/session/viewState";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  suspend: vi.fn(),
  prepare: vi.fn(),
  resume: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({
  api: { mainWindowSnapshot: mocks.snapshot, mainWindowSuspend: mocks.suspend },
  isTauri: () => true,
  events: {},
}));
vi.mock("@/features/terminal/terminalCheckpoint", () => ({
  prepareTerminalCheckpoints: mocks.prepare,
  resumeTerminalCheckpoints: mocks.resume,
  restoreTerminalCheckpoints: mocks.restore,
}));

import { restoreBackgroundSnapshot, suspendBackgroundWindow } from "@/app/backgroundWindow";

beforeEach(() => {
  vi.clearAllMocks();
  useTransferPanel.setState({ open: false, pinned: false });
  mocks.snapshot.mockResolvedValue(null);
  mocks.prepare.mockResolvedValue({ one: { sequence: 7, data: "screen" } });
  mocks.resume.mockResolvedValue(undefined);
  mocks.suspend.mockResolvedValue(true);
  useWorkspace.setState({
    tabs: [{ id: "terminal:one", kind: "terminal", title: "SSH", hostId: "host", pinned: false }],
    panes: [{ id: "pane-1", tabIds: ["terminal:one"], activeId: "terminal:one", locked: true }],
    layout: { kind: "pane", paneId: "pane-1" },
    activeId: "terminal:one",
    activePaneId: "pane-1",
    split: null,
  });
  useSsh.setState({
    sessions: [
      {
        id: "one",
        hostId: "host",
        title: "SSH",
        address: "server:22",
        cols: 80,
        rows: 24,
        connectedAt: 1,
      },
    ],
    connectingHostIds: [],
    disconnectingSessionIds: [],
  });
  useEditors.setState({
    entries: {
      draft: {
        tabId: "draft",
        sessionId: "one",
        path: "/home/test/new.txt",
        name: "new.txt",
        content: "unsaved changes",
        baseline: "original",
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  useDialogs.setState({ dialog: { kind: "none" } });
  useSettings.setState({ settings: DEFAULT_SETTINGS, saving: false });
  usePlugins.setState({
    outputs: { uuid: { text: "uuid result", error: false } },
    busyIds: [],
    reloading: false,
  });
  usePluginSecurity.setState({ busy: false, prompts: [] });
  useMarketplace.setState({ tasks: {} });
  useSettingsProfiles.setState({ busy: false });
  useStorage.setState({
    busy: false,
    draft: [{ category: "logs", target: "D:\\Logs", migrate: true }],
  });
  useNavigation.setState({
    sidebarVisible: false,
    activeSidebar: "hosts",
    visitedSidebars: ["hosts"],
    settingsSection: "terminal",
  });
  restoreViewState({ "chat:one": "unfinished message", collapsed: new Set(["hosts"]) });
});

describe("background window checkpoint", () => {
  it("releases a WebView with a pinned nonmodal task list and restores its state", async () => {
    const panel = document.createElement("aside");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    document.body.append(panel);
    useTransferPanel.setState({ open: true, pinned: true });
    try {
      await suspendBackgroundWindow(71);
      expect(mocks.suspend).toHaveBeenCalledWith(71, expect.any(String));
      const snapshot = mocks.suspend.mock.calls[0]![1] as string;
      useTransferPanel.setState({ open: false, pinned: false });
      mocks.snapshot.mockResolvedValue(snapshot);
      await restoreBackgroundSnapshot();
      expect(useTransferPanel.getState()).toMatchObject({ open: true, pinned: true });
    } finally {
      panel.remove();
    }
  });
  it("keeps drafts, pane locks, tool results and live sessions in memory across recreation", async () => {
    await suspendBackgroundWindow(1);
    expect(mocks.prepare).toHaveBeenCalledWith(["one"]);
    const encoded = mocks.suspend.mock.calls[0]![1] as string;
    expect(encoded).toContain("unsaved changes");
    useEditors.setState({ entries: {} });
    useWorkspace.setState({ tabs: [], panes: [] });
    usePlugins.setState({ outputs: {} });
    restoreViewState({});
    mocks.snapshot.mockResolvedValue(encoded);
    expect(await restoreBackgroundSnapshot()).toBe(true);
    expect(useEditors.getState().entries.draft?.content).toBe("unsaved changes");
    expect(useEditors.getState().entries.draft?.baseline).toBe("original");
    expect(useWorkspace.getState().panes[0]?.locked).toBe(true);
    expect(usePlugins.getState().outputs.uuid?.text).toBe("uuid result");
    expect(useNavigation.getState().settingsSection).toBe("terminal");
    expect(viewStateSnapshot().collapsed).toEqual(new Set(["hosts"]));
    expect(mocks.restore).toHaveBeenCalledWith({ one: { sequence: 7, data: "screen" } });
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("does not require a terminal page for file-management-only SSH connections", async () => {
    useWorkspace.setState({ tabs: [] });
    await suspendBackgroundWindow(2);
    expect(mocks.prepare).toHaveBeenCalledWith([]);
    expect(mocks.suspend).toHaveBeenCalledWith(2, expect.any(String));
  });

  it("defers while an editor save or dialog is active without detaching SSH", async () => {
    useEditors.setState({
      entries: { draft: { ...useEditors.getState().entries.draft!, saving: true } },
    });
    await suspendBackgroundWindow(3);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.suspend).toHaveBeenCalledWith(3, null);
  });

  it("reconnects detached terminals when native suspension is cancelled or snapshot creation fails", async () => {
    mocks.suspend.mockResolvedValueOnce(false);
    await suspendBackgroundWindow(4);
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.suspend).toHaveBeenLastCalledWith(4, null);
    mocks.prepare.mockRejectedValueOnce(new Error("checkpoint busy"));
    await suspendBackgroundWindow(5);
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.suspend).toHaveBeenLastCalledWith(5, null);
  });

  it("serializes a single checkpoint and rechecks in-flight writes after terminal preparation", async () => {
    let finish!: (value: object) => void;
    mocks.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const preparing = suspendBackgroundWindow(6);
    await suspendBackgroundWindow(7);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    useStorage.setState({ busy: true });
    finish({});
    await preparing;
    expect(mocks.suspend).toHaveBeenCalledWith(6, null);
    expect(mocks.suspend).not.toHaveBeenCalledWith(6, expect.any(String));
  });

  it("does not revive unsupported snapshots or overwrite stores on a normal startup", async () => {
    expect(await restoreBackgroundSnapshot()).toBe(false);
    expect(useEditors.getState().entries.draft?.content).toBe("unsaved changes");
    mocks.snapshot.mockResolvedValue(encodeViewSnapshot({ version: 2, workspace: { tabs: [] } }));
    await expect(restoreBackgroundSnapshot()).rejects.toThrow("window.invalidSnapshot");
    expect(
      decodeViewSnapshot(encodeViewSnapshot({ set: new Set(["a"]), map: new Map([["x", 3]]) })),
    ).toEqual({ set: new Set(["a"]), map: new Map([["x", 3]]) });
  });
});
