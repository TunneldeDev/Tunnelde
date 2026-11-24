export const HABIT_CATEGORIES = [
  "windows",
  "panels",
  "typography",
  "appearance",
  "files",
  "workspace",
] as const;
export type HabitCategory = (typeof HABIT_CATEGORIES)[number];
export interface HabitDetail {
  label: string;
  value: string;
  origin: "saved" | "current" | "default";
}
export interface HabitsData {
  ready: boolean;
  saving: boolean;
  error: string | null;
  entries: number;
  workspaceCleared: boolean;
}
