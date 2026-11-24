import { beforeEach, expect, it, vi } from "vitest";
import { loadHabitDetails } from "@/store/habitDetails";
import { useSettings } from "@/store/settings";
import { createDefaultSettings } from "@/lib/prefs/defaults";
const api = vi.hoisted(() => ({
  settings: vi.fn(),
  habits: vi.fn(),
  tabs: vi.fn(),
  windowHabits: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  useSettings.setState({ settings: createDefaultSettings() });
});
it("projects only the requested settings fields, without network credentials", async () => {
  api.settings.mockResolvedValue({
    ...createDefaultSettings(),
    uiFontSize: 16,
    network: { password: "never-display" },
  });
  const rows = await loadHabitDetails("typography");
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "16", origin: "saved" }),
      expect.objectContaining({ value: "13", origin: "current" }),
    ]),
  );
  expect(JSON.stringify(rows)).not.toContain("never-display");
  expect(api.habits).not.toHaveBeenCalled();
});
it("exposes saved panel geometry and separates a newer local value", async () => {
  api.habits.mockResolvedValue({
    "tunnelde.panels.tasks.bounds": '{"x":12,"y":34}',
    "tunnelde:file-view:v1:other": "file-only",
  });
  localStorage.setItem("tunnelde.panels.tasks.bounds", '{"x":56,"y":78}');
  const rows = await loadHabitDetails("panels");
  expect(rows.map((r) => r.origin)).toEqual(["saved", "current"]);
  expect(rows[0]?.value).toContain('"x": 12');
  expect(JSON.stringify(rows)).not.toContain("file-only");
});
it("projects known workspace fields and excludes arbitrary tab state", async () => {
  api.tabs.mockResolvedValue([
    {
      title: "Files",
      kind: "sidebar",
      pinned: false,
      state: JSON.stringify({
        localFilePanes: { files: "/home/example" },
        layout: { type: "leaf", paneId: "pane-1" },
        content: "never-display",
        password: "never-display",
      }),
    },
  ]);
  const rows = await loadHabitDetails("workspace");
  expect(JSON.stringify(rows)).toContain("/home/example");
  expect(JSON.stringify(rows)).not.toContain("never-display");
});
