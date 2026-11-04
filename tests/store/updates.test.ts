import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UpdateState } from "@/lib/api/types";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { matchingUpdateState, useUpdates } from "@/store/updates";
import { useSettings } from "@/store/settings";

const mock = vi.hoisted(() => ({
  installUpdate: vi.fn(),
  checkUpdates: vi.fn(),
  toast: vi.fn(),
  update: vi.fn(),
  updateState: vi.fn(),
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
  useUpdates.setState({ state: { ...state }, busy: false });
  useSettings.setState({ settings: { ...settings }, update: mock.update });
});

describe("update operation state", () => {
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
