import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHabits, resetHabits, restoreWorkspaceHabits, useHabits } from "@/store/habits";
import { panelPresentation } from "@/store/panelPresentation";
import { habitStorage } from "@/lib/habits/storage";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { AppInfo } from "@/lib/api/types";
const api = vi.hoisted(() => ({
  habits: vi.fn(),
  saveHabits: vi.fn(),
  resetWindowHabits: vi.fn(),
  saveTabs: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
let stop: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  api.habits.mockResolvedValue(null);
  api.saveHabits.mockResolvedValue(undefined);
  useHabits.setState({
    ready: false,
    saving: false,
    error: null,
    entries: 0,
    workspaceCleared: false,
  });
  const defaults = createDefaultSettings();
  useSettings.setState({
    info: { defaultSettings: defaults } as AppInfo,
    settings: defaults,
    update: vi.fn(async () => true),
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
});
describe("durable user habits", () => {
  it("restores the native snapshot over an outdated cache, including pre-created panels", async () => {
    const panel = panelPresentation("tasks");
    localStorage.setItem("tunnelde.panels.tasks.bounds", "old");
    const bounds = { x: 100, y: 200, width: 420, height: 320 };
    api.habits.mockResolvedValue({
      "tunnelde.panels.tasks.bounds": JSON.stringify(bounds),
      "tunnelde.panels.tasks.open": "true",
      "tunnelde.panels.tasks.pinned": "true",
    });
    stop = await startHabits();
    expect(panel.getState()).toMatchObject({ bounds, open: true, pinned: true });
    expect(useHabits.getState().ready).toBe(true);
  });
  it("migrates browser habits only when no native record exists", async () => {
    localStorage.setItem("tunnelde.panels.tasks.presentation", "floating");
    stop = await startHabits();
    await vi.waitFor(() =>
      expect(api.saveHabits).toHaveBeenCalledWith(
        expect.objectContaining({ "tunnelde.panels.tasks.presentation": "floating" }),
      ),
    );
  });
  it("preserves unreadable native data and reports the failure without saving defaults", async () => {
    api.habits.mockRejectedValue(new Error("database unavailable"));
    stop = await startHabits();
    habitStorage.setItem("tunnelde.panels.tasks.open", "true");
    expect(api.saveHabits).not.toHaveBeenCalled();
    expect(useHabits.getState()).toMatchObject({ ready: false, error: expect.any(String) });
  });
  it("serializes changes so a slow write cannot replace a newer position", async () => {
    let release!: () => void;
    api.saveHabits.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    stop = await startHabits();
    habitStorage.setItem("tunnelde.panels.tasks.open", "true");
    habitStorage.setItem("tunnelde.panels.tasks.open", "false");
    expect(api.saveHabits).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(api.saveHabits).toHaveBeenCalledTimes(2));
    expect(api.saveHabits.mock.lastCall?.[0]["tunnelde.panels.tasks.open"]).toBe("false");
  });
  it("clears only the next-start workspace snapshot and preserves current editors", async () => {
    stop = await startHabits();
    const tabs = useWorkspace.getState().tabs;
    await resetHabits(["workspace"]);
    expect(api.saveTabs).toHaveBeenCalledWith([]);
    expect(useWorkspace.getState().tabs).toBe(tabs);
    expect(useHabits.getState().workspaceCleared).toBe(true);
    expect(useSettings.getState().update).not.toHaveBeenCalled();
  });
  it("restores private floating geometry without changing public workspace records", () => {
    const bounds = { x: 500, y: 300, width: 400, height: 300 };
    useWorkspace.setState({
      panes: [
        { id: "root", tabIds: [], activeId: null },
        { id: "floating", tabIds: ["host:x"], activeId: "host:x" },
      ],
    });
    localStorage.setItem(
      "tunnelde.workspace.floating",
      JSON.stringify({ floating: { bounds, returnPaneId: "root" } }),
    );
    const cleanup = restoreWorkspaceHabits();
    expect(useWorkspace.getState().panes[1]?.floating).toMatchObject({
      bounds,
      returnPaneId: "root",
    });
    cleanup();
  });
});

it("persists per-host dashboard layouts and clears them with panel habits", async () => {
  stop = await startHabits();
  const key = "tunnelde.panels.monitor-dashboard.host-a.layout";
  const value = JSON.stringify({ version: 1, widgets: [{ id: "cpu", columns: 12, height: 500 }] });
  habitStorage.setItem(key, value);
  await vi.waitFor(() =>
    expect(api.saveHabits).toHaveBeenLastCalledWith(expect.objectContaining({ [key]: value })),
  );
  await resetHabits(["panels"]);
  expect(localStorage.getItem(key)).toBeNull();
  await vi.waitFor(() => expect(api.saveHabits.mock.lastCall?.[0][key]).toBeUndefined());
});
