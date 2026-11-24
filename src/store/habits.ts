import { create } from "zustand";
import { api } from "@/lib/api/ipc";
import { presentError } from "@/lib/api/errors";
import { habitEntries, habitStorage, HABITS_CHANGED, isHabitKey } from "@/lib/habits/storage";
import { panelPresentation, restorePanelHabits } from "./panelPresentation";
import { useNavigation, type BuiltinSidebarView } from "./navigation";
import { useWorkspace } from "./workspace";
import { useSettings } from "./settings";
import { useFilePreview } from "./filePreview";
import { isFloatingRect } from "@/lib/layout/floatingPanel";

import { HABIT_CATEGORIES, type HabitCategory, type HabitsData } from "@/lib/habits/types";
export const useHabits = create<HabitsData>(() => ({
  ready: false,
  saving: false,
  error: null,
  entries: 0,
  workspaceCleared: false,
}));
const sidebars: BuiltinSidebarView[] = [
  "hosts",
  "knownHosts",
  "plugins",
  "forwarding",
  "tasks",
  "output",
  "filePreview",
  "connections",
];
let save: (() => Promise<void>) | undefined;
export const fontKeys = ["uiFontSize", "monoFontSize", "monoFont", "fontSelections"] as const;
export const appearanceKeys = [
  "theme",
  "accent",
  "colors",
  "density",
  "motion",
  "sidebarWidth",
  "rightPanel",
  "rightPanelWidth",
  "hostList",
  "userCss",
] as const;

export async function startHabits(): Promise<() => void> {
  useHabits.setState({ workspaceCleared: false });
  let disposed = false;
  let running: Promise<void> | undefined;
  let queued = false;
  try {
    const stored = await api.habits();
    if (stored !== null) {
      for (const key of Object.keys(habitEntries())) localStorage.removeItem(key);
      for (const [key, value] of Object.entries(stored))
        if (isHabitKey(key)) localStorage.setItem(key, value);
    }
    for (const view of sidebars) panelPresentation(view);
    restorePanelHabits();
    useFilePreview.setState({
      presentation:
        habitStorage.getItem("tunnelde.filePreview.presentation") === "docked"
          ? "docked"
          : "quickLook",
    });
    try {
      const nav = JSON.parse(habitStorage.getItem("tunnelde.navigation") ?? "null");
      if (nav && sidebars.includes(nav.activeSidebar) && typeof nav.sidebarVisible === "boolean") {
        useNavigation.setState({
          activeSidebar: nav.activeSidebar,
          sidebarVisible: nav.sidebarVisible,
          visitedSidebars: sidebars.filter(
            (view) => view === nav.activeSidebar || panelPresentation(view).getState().open,
          ),
        });
      }
    } catch {
      /* Individual obsolete preferences do not invalidate the durable store. */
    }
    useHabits.setState({ ready: true, error: null, entries: Object.keys(habitEntries()).length });
  } catch (error) {
    // Never overwrite unreadable durable data with an empty browser cache.
    useHabits.setState({ ready: false, error: presentError(error) });
    return () => {};
  }
  const flush = (): Promise<void> => {
    queued = true;
    if (running) return running;
    running = (async () => {
      useHabits.setState({ saving: true });
      try {
        while (queued) {
          queued = false;
          const values = habitEntries();
          await api.saveHabits(values);
          useHabits.setState({ entries: Object.keys(values).length, error: null });
        }
      } catch (error) {
        useHabits.setState({ error: presentError(error) });
        throw error;
      } finally {
        running = undefined;
        useHabits.setState({ saving: false });
      }
    })();
    return running;
  };
  save = flush;
  const changed = () => {
    if (!disposed) void flush().catch(() => {});
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || isHabitKey(event.key)) changed();
  };
  window.addEventListener(HABITS_CHANGED, changed);
  window.addEventListener("storage", storage);
  const stopNavigation = useNavigation.subscribe((state, previous) => {
    if (
      state.activeSidebar !== previous.activeSidebar ||
      state.sidebarVisible !== previous.sidebarVisible
    )
      habitStorage.setItem(
        "tunnelde.navigation",
        JSON.stringify({
          activeSidebar: state.activeSidebar,
          sidebarVisible: state.sidebarVisible,
        }),
      );
  });
  changed(); // One-time migration also records an intentionally empty cache.
  return () => {
    disposed = true;
    save = undefined;
    stopNavigation();
    window.removeEventListener(HABITS_CHANGED, changed);
    window.removeEventListener("storage", storage);
  };
}

/** Private geometry extension; the public workspace v1 shape stays unchanged. */
export function restoreWorkspaceHabits() {
  try {
    const records = JSON.parse(habitStorage.getItem("tunnelde.workspace.floating") ?? "{}");
    const state = useWorkspace.getState();
    useWorkspace.setState({
      panes: state.panes.map((pane) => {
        const saved = records[pane.id];
        return saved &&
          (saved.bounds === null || isFloatingRect(saved.bounds)) &&
          typeof saved.returnPaneId === "string" &&
          state.panes.some((p) => p.id === saved.returnPaneId && p.id !== pane.id)
          ? {
              ...pane,
              floating: { bounds: saved.bounds, returnPaneId: saved.returnPaneId, order: 0 },
            }
          : pane;
      }),
    });
  } catch {
    /* Keep the normal workspace when obsolete geometry cannot be read. */
  }
  return useWorkspace.subscribe((state, previous) => {
    if (state.panes === previous.panes) return;
    habitStorage.setItem(
      "tunnelde.workspace.floating",
      JSON.stringify(
        Object.fromEntries(
          state.panes.flatMap((p) =>
            p.floating
              ? [[p.id, { bounds: p.floating.bounds, returnPaneId: p.floating.returnPaneId }]]
              : [],
          ),
        ),
      ),
    );
  });
}

export async function resetHabits(categories: HabitCategory[]) {
  if (
    !useHabits.getState().ready ||
    !Array.isArray(categories) ||
    !categories.length ||
    categories.some((v) => !HABIT_CATEGORIES.includes(v))
  )
    throw new Error("invalid user habits");
  const defaults = useSettings.getState().info?.defaultSettings;
  if (!defaults) throw new Error("settings unavailable");
  if (categories.includes("typography") || categories.includes("appearance")) {
    const keys = [
      ...(categories.includes("typography") ? fontKeys : []),
      ...(categories.includes("appearance") ? appearanceKeys : []),
    ];
    if (
      !(await useSettings.getState().update(Object.fromEntries(keys.map((k) => [k, defaults[k]]))))
    )
      throw new Error("settings update failed");
  }
  if (categories.includes("windows")) await api.resetWindowHabits();
  if (categories.includes("workspace")) {
    // Suppress subsequent autosaves until restart, without closing dirty editors.
    useHabits.setState({ workspaceCleared: true });
    try {
      await api.saveTabs([]);
    } catch (error) {
      useHabits.setState({ workspaceCleared: false });
      throw error;
    }
  }
  for (const key of Object.keys(habitEntries())) {
    if (
      (categories.includes("panels") &&
        (key.startsWith("tunnelde.panels.") ||
          [
            "tunnelde.navigation",
            "tunnelde.workspace.floating",
            "tunnelde.backgroundTasks.bounds",
            "tunnelde.transferPanel.bounds",
          ].includes(key))) ||
      (categories.includes("files") &&
        (key.startsWith("tunnelde:file-") || key === "tunnelde.filePreview.presentation"))
    )
      habitStorage.removeItem(key);
  }
  if (categories.includes("panels")) {
    restorePanelHabits();
    useNavigation.setState({ activeSidebar: "hosts", sidebarVisible: true });
    useWorkspace.setState((s) => ({
      panes: s.panes.map(({ floating: _floating, ...pane }) => pane),
    }));
  }
  if (categories.includes("files")) useFilePreview.setState({ presentation: "quickLook" });
  await save?.();
}
