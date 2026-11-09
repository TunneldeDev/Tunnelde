import { beforeEach, describe, expect, it, vi } from "vitest";
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
  useShortcutConflicts.setState({ queue: [], resolving: false, query: "", request: 0 });
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
  it("drops stale queued pairs after removing their shared binding", async () => {
    const second = { ...plugin, id: "other", name: "Other" };
    usePlugins.setState({ items: [plugin, second] });
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin, second]);
    expect(useShortcutConflicts.getState().queue.length).toBeGreaterThan(1);
    await useShortcutConflicts.getState().resolve("palette.content");
    expect(useShortcutConflicts.getState().queue).toEqual([
      { incoming: id, existing: "plugin.c.5.other.format", binding: "Mod+Alt+J" },
    ]);
  });
  it("removes only the selected conflicting binding and retains the other keys", async () => {
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin]);
    await useShortcutConflicts.getState().resolve("palette.content");
    expect(useSettings.getState().settings.keyboardShortcuts[id]).toEqual(["Mod+Alt+J"]);
    expect(useShortcutConflicts.getState().queue).toEqual([]);
  });
  it("does not discard the next dialog when a pending resolution finishes after dismissal", async () => {
    const second = { ...plugin, id: "other", name: "Other" };
    usePlugins.setState({ items: [plugin, second] });
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin, second]);
    const next = useShortcutConflicts.getState().queue[1];
    let finish!: (value: boolean) => void;
    const update = vi.spyOn(useSettings.getState(), "update").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = useShortcutConflicts.getState().resolve(id);
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      useShortcutConflicts.getState().dismiss();
      finish(true);
      await pending;
      expect(useShortcutConflicts.getState().queue).toContainEqual(next);
    } finally {
      update.mockRestore();
    }
  });
  it("serializes choices so repeated clicks cannot persist opposite resolutions", async () => {
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin]);
    let finish!: (value: boolean) => void;
    const update = vi.spyOn(useSettings.getState(), "update").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = useShortcutConflicts.getState().resolve(id);
      expect(useShortcutConflicts.getState().resolving).toBe(true);
      await useShortcutConflicts.getState().resolve("palette.content");
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      expect(update.mock.calls[0]?.[0]?.keyboardShortcuts).toEqual({ "palette.content": [] });
      finish(true);
      await pending;
      expect(useShortcutConflicts.getState().resolving).toBe(false);
    } finally {
      update.mockRestore();
    }
  });
  it("keeps the unresolved pair available after persistence failure", async () => {
    useShortcutConflicts.getState().enqueue(undefined, plugin, [plugin]);
    const queue = useShortcutConflicts.getState().queue;
    const update = vi.spyOn(useSettings.getState(), "update").mockResolvedValue(false);
    try {
      await useShortcutConflicts.getState().resolve(id);
      expect(useShortcutConflicts.getState().queue).toEqual(queue);
      expect(useShortcutConflicts.getState().resolving).toBe(false);
    } finally {
      update.mockRestore();
    }
  });
});
