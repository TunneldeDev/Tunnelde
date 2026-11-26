/** Version-independent local cache. Only the main document mirrors it to SQLite. */
export const HABITS_CHANGED = "tunnelde:habits-changed";
export const isHabitKey = (key: string) =>
  key.startsWith("tunnelde.panels.") ||
  key.startsWith("tunnelde:file-view:v1:") ||
  key.startsWith("tunnelde:file-split:") ||
  key === "tunnelde.filePreview.presentation" ||
  key === "tunnelde.navigation" ||
  key === "tunnelde.workspace.floating" ||
  key === "tunnelde.backgroundTasks.bounds" ||
  key === "tunnelde.transferPanel.bounds";
export function habitEntries(): Record<string, string> {
  return Object.fromEntries(
    Object.keys(localStorage)
      .filter(isHabitKey)
      .map((key) => [key, localStorage.getItem(key)!]),
  );
}
export const habitStorage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    localStorage.setItem(key, value);
    window.dispatchEvent(new Event(HABITS_CHANGED));
  },
  removeItem(key: string) {
    localStorage.removeItem(key);
    window.dispatchEvent(new Event(HABITS_CHANGED));
  },
};
