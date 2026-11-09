import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseHistory, Settings, UpdateState } from "@/lib/api/types";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { matchingUpdateState, useUpdates } from "@/store/updates";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";

const mock = vi.hoisted(() => ({
  installUpdate: vi.fn(),
  checkUpdates: vi.fn(),
  toast: vi.fn(),
  update: vi.fn(),
  updateState: vi.fn(),
  updateHistory: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: mock }));
vi.mock("@/store/toasts", () => ({ toast: mock.toast }));
const settings = createDefaultSettings();
const state: UpdateState = {
  phase: "available",
  currentVersion: "0.26.1",
  channel: "stable",
  source: "github",
  sourceUrl: "",
  version: "0.26.2",
  notes: null,
  publishedAt: null,
  progress: null,
  contentLength: null,
  error: null,
  lastChecked: 1,
  available: true,
  autoInstall: true,
  unsupportedReason: null,
  downloadUrl: null,
  skipped: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  useUpdates.setState({ state: { ...state }, busy: false, history: null });
  useSettings.setState({ settings: { ...settings }, update: mock.update });
});

describe("release history independent of installation", () => {
  const history: ReleaseHistory = {
    currentVersion: state.currentVersion,
    version: state.version!,
    entries: [{ version: state.version!, notes: "Target notes", publishedAt: null }],
    complete: true,
    reason: null,
  };

  it("deduplicates loads, caches the result and leaves update actions enabled", async () => {
    let resolve!: (value: ReleaseHistory) => void;
    mock.updateHistory.mockReturnValueOnce(
      new Promise<ReleaseHistory>((done) => {
        resolve = done;
      }),
    );
    const pending = useUpdates.getState().loadHistory();
    await useUpdates.getState().loadHistory();
    expect(mock.updateHistory).toHaveBeenCalledExactlyOnceWith(state.version);
    expect(useUpdates.getState().busy).toBe(false);
    expect(useUpdates.getState().state?.phase).toBe("available");
    resolve(history);
    await pending;
    await useUpdates.getState().loadHistory();
    expect(mock.updateHistory).toHaveBeenCalledOnce();
    expect(useUpdates.getState().history?.data).toBe(history);
  });

  it("ignores a late history result when settings change and allows loading after switching back", async () => {
    let resolve!: (value: ReleaseHistory) => void;
    mock.updateHistory.mockReturnValueOnce(
      new Promise<ReleaseHistory>((done) => {
        resolve = done;
      }),
    );
    const pending = useUpdates.getState().loadHistory();
    useSettings.setState({ settings: { ...settings, updateChannel: "beta" } });
    resolve(history);
    await pending;
    expect(useUpdates.getState().history).toBeNull();
    useSettings.setState({ settings: { ...settings } });
    mock.updateHistory.mockResolvedValueOnce(history);
    await useUpdates.getState().loadHistory();
    expect(useUpdates.getState().history?.data).toBe(history);
    expect(mock.updateHistory).toHaveBeenCalledTimes(2);
  });

  it("retains a newer request when an old check finishes late", async () => {
    let resolve!: (value: ReleaseHistory) => void;
    mock.updateHistory.mockReturnValueOnce(
      new Promise<ReleaseHistory>((done) => {
        resolve = done;
      }),
    );
    const pending = useUpdates.getState().loadHistory();
    useUpdates.getState().apply({ ...state, lastChecked: 2 });
    const newer = {
      ...history,
      entries: [{ version: state.version!, notes: "New", publishedAt: null }],
    };
    mock.updateHistory.mockResolvedValueOnce(newer);
    await useUpdates.getState().loadHistory();
    resolve(history);
    await pending;
    expect(useUpdates.getState().history?.data).toBe(newer);
  });

  it("reports history errors inline, retries and preserves installation state", async () => {
    mock.updateHistory.mockRejectedValueOnce(new Error("history unavailable"));
    await useUpdates.getState().loadHistory();
    expect(useUpdates.getState().history?.error).toBe("history unavailable");
    expect(useUpdates.getState().state).toEqual(state);
    expect(mock.toast).not.toHaveBeenCalled();
    mock.updateHistory.mockResolvedValueOnce(history);
    await useUpdates.getState().loadHistory(true);
    expect(useUpdates.getState().history?.data).toBe(history);
    expect(useUpdates.getState().history?.error).toBeNull();
  });
});

describe("update operation state", () => {
  it("offers persistent diagnostic navigation for a structured source failure", async () => {
    mock.checkUpdates.mockRejectedValueOnce({
      code: "update",
      message: "updates.sourcesUnavailable",
      details: {
        sourceErrors: [
          {
            source: "github-api",
            reason: "updates.rateLimited",
            status: 403,
            retryAt: 1_800_000_000_000,
          },
          { source: "github-public-feed", reason: "updates.timeout", status: null, retryAt: null },
        ],
      },
    });
    await useUpdates.getState().check();
    expect(useUpdates.getState().busy).toBe(false);
    expect(mock.toast).toHaveBeenCalledOnce();
    const action = mock.toast.mock.calls[0]![2];
    expect(typeof action.onClick).toBe("function");
    useWorkspace.getState().hydrate([]);
    useNavigation.setState({ settingsSection: "general" });
    action.onClick();
    expect(useNavigation.getState().settingsSection).toBe("updates");
    expect(useWorkspace.getState().tabs.filter((tab) => tab.kind === "settings")).toHaveLength(1);
  });

  it("retains a newer event when an older status snapshot arrives late", async () => {
    let resolve!: (value: UpdateState) => void;
    mock.updateState.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = useUpdates.getState().refresh();
    const downloading = { ...state, phase: "downloading" as const, progress: 50 };
    useUpdates.getState().apply(downloading);
    resolve(state);
    await pending;
    expect(useUpdates.getState().state).toBe(downloading);
  });

  it("ignores duplicate install and check calls while an install is pending", async () => {
    let resolve!: () => void;
    mock.installUpdate.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const pending = useUpdates.getState().install();
    await useUpdates.getState().install();
    await useUpdates.getState().check();
    expect(mock.installUpdate).toHaveBeenCalledOnce();
    expect(mock.checkUpdates).not.toHaveBeenCalled();
    resolve();
    await pending;
    expect(useUpdates.getState().busy).toBe(false);
  });

  it("unlocks and reports failed installations", async () => {
    mock.installUpdate.mockRejectedValueOnce(new Error("download failed"));
    await useUpdates.getState().install();
    expect(mock.toast).toHaveBeenCalledWith("download failed", "error");
    expect(useUpdates.getState().busy).toBe(false);
  });

  it("does not report a skip as saved if persisting the setting fails", async () => {
    mock.update.mockResolvedValueOnce(false);
    await useUpdates.getState().skip();
    expect(useUpdates.getState().state?.skipped).toBe(false);
    mock.update.mockResolvedValueOnce(true);
    await useUpdates.getState().skip();
    expect(useUpdates.getState().state?.skipped).toBe(true);
  });

  it("rejects stale selections after channel, source or URL changes", () => {
    expect(matchingUpdateState(state, settings)).toBe(state);
    for (const patch of [
      { updateChannel: "beta" },
      { updateChannel: "nightly" },
      { updateSource: "custom" },
      { updateSourceUrl: "https://mirror.example.com/{channel}.json" },
    ]) {
      expect(matchingUpdateState(state, { ...settings, ...patch } as Settings)).toBeNull();
    }
  });

  it("does not skip a replacement version while an earlier skip is being saved", async () => {
    let resolve!: (saved: boolean) => void;
    mock.update.mockReturnValueOnce(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    const pending = useUpdates.getState().skip();
    useUpdates.setState({ state: { ...state, version: "0.26.3" } });
    resolve(true);
    await pending;
    expect(useUpdates.getState().state?.skipped).toBe(false);
  });
});
