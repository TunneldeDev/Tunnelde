import { beforeEach, describe, expect, it } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { useShortcutConflicts } from "@/store/shortcutConflicts";

const plugin = {
  id: "formatter",
  name: "Formatter",
  runtime: "node",
  views: [],
  commands: [
    {
      id: "format",
      title: "Format",
      keybindings: ["Mod+Shift+F", "Mod+Alt+J"],
      editor: { extensions: ["json"] },
    },
  ],
} as unknown as PluginInfo;
const id = "plugin.c.9.formatter.format";
beforeEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keyboardShortcuts: {} } });
  usePlugins.setState({ items: [plugin] });
  useShortcutConflicts.setState({ queue: [], query: "", request: 0 });
});
describe("plugin shortcut conflicts", () => {
  it("queues new conflicts and does not repeat an unchanged update", () => {
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin]);
    expect(useShortcutConflicts.getState().queue).toEqual([
      { incoming: id, existing: "palette.content", binding: "Mod+Shift+F" },
    ]);
    useShortcutConflicts.setState({ queue: [] });
    useShortcutConflicts.getState().enqueue(plugin, plugin, [plugin]);
    expect(useShortcutConflicts.getState().queue).toEqual([]);
  });
  it("removes only the selected conflicting binding and retains the other keys", async () => {
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin]);
    await useShortcutConflicts.getState().resolve("palette.content");
    expect(useSettings.getState().settings.keyboardShortcuts[id]).toEqual(["Mod+Alt+J"]);
    expect(useShortcutConflicts.getState().queue).toEqual([]);
  });
});
