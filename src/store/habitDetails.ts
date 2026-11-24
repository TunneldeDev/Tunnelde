import i18n from "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import { HABIT_CATEGORIES, type HabitCategory, type HabitDetail } from "@/lib/habits/types";
import { habitEntries } from "@/lib/habits/storage";
import { useEditors } from "./editors";
import { useSettings } from "./settings";
import { workspaceRecords } from "./workspace";
import { useHabits, fontKeys, appearanceKeys } from "./habits";

const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "—");
const parse = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};
const label = (key: string) => i18n.t(`habits.fields.${key}`, { defaultValue: key });
/** On-demand owner read: never includes editor text, credentials, or arbitrary settings. */
export async function loadHabitDetails(category: HabitCategory): Promise<HabitDetail[]> {
  if (!HABIT_CATEGORIES.includes(category)) throw new Error("invalid user habits category");
  const rows: HabitDetail[] = [];
  const add = (name: string, value: unknown, origin: HabitDetail["origin"]) =>
    rows.push({ label: name, value: valueText(value), origin });
  if (category === "windows") {
    for (const row of await api.windowHabits()) {
      const name = row.name === "main" ? label("main") : row.name;
      add(name, row.current, "current");
      if (row.saved != null) add(name, row.saved, "saved");
      else
        add(
          name,
          { width: row.name === "main" ? 1280 : 1024, height: 800, position: "center" },
          "default",
        );
    }
  } else if (category === "typography" || category === "appearance") {
    const saved = await api.settings();
    const { settings, info } = useSettings.getState();
    for (const key of category === "typography" ? fontKeys : appearanceKeys) {
      add(label(key), saved[key], "saved");
      if (JSON.stringify(saved[key]) !== JSON.stringify(settings[key]))
        add(label(key), settings[key], "current");
      if (info) add(label(key), info.defaultSettings[key], "default");
    }
  } else if (category === "workspace") {
    const saved = await api.tabs();
    const describe = (
      records: Awaited<ReturnType<typeof api.tabs>>,
      origin: HabitDetail["origin"],
    ) => {
      for (const tab of records)
        add(label("tabs"), { title: tab.title, kind: tab.kind, pinned: tab.pinned }, origin);
      // Only project known layout/path fields. Never show arbitrary tab state or document content.
      for (const record of records) {
        const snapshot = record.state ? parse(record.state) : null;
        if (!snapshot || typeof snapshot !== "object") continue;
        const s = snapshot as Record<string, unknown>;
        if (s.localFilePanes || s.remoteFilePanes)
          add(
            label("paths"),
            { local: s.localFilePanes ?? {}, remote: s.remoteFilePanes ?? {} },
            origin,
          );
        if (s.layout) add(label("layout"), s.layout, origin);
        break;
      }
    };
    describe(saved, "saved");
    // A reset intentionally leaves live editors open but clears next-start recovery.
    if (
      useHabits.getState().workspaceCleared ||
      JSON.stringify(saved) !== JSON.stringify(workspaceRecords())
    )
      describe(workspaceRecords(), "current");
    for (const entry of Object.values(useEditors.getState().entries)) {
      add(label("paths"), { title: entry.name, path: entry.path }, "current");
    }
  } else {
    const accepts = (key: string) =>
      category === "panels"
        ? key.startsWith("tunnelde.panels.") ||
          [
            "tunnelde.navigation",
            "tunnelde.workspace.floating",
            "tunnelde.backgroundTasks.bounds",
            "tunnelde.transferPanel.bounds",
          ].includes(key)
        : key.startsWith("tunnelde:file-") || key === "tunnelde.filePreview.presentation";
    const describe = (key: string) =>
      key
        .replace(/^tunnelde\.panels\./, "")
        .replace(/^tunnelde\./, "")
        .split(".")
        .map(label)
        .join(" · ");
    const saved = (await api.habits()) ?? {};
    const current = habitEntries();
    for (const key of [...new Set([...Object.keys(saved), ...Object.keys(current)])]
      .filter(accepts)
      .sort()) {
      if (key in saved) add(describe(key), parse(saved[key]!), "saved");
      if (key in current && current[key] !== saved[key])
        add(describe(key), parse(current[key]!), "current");
    }
  }
  return rows;
}
