import { create } from "zustand";
import type { PluginInfo } from "@/lib/api/types";
import {
  bindingsFor,
  shortcutCommands,
  shortcutConflicts,
  displayShortcut,
} from "@/lib/keyboard/registry";
import { useSettings } from "@/store/settings";

export interface PendingShortcutConflict {
  incoming: string;
  existing: string;
  binding: string;
}
interface State {
  queue: PendingShortcutConflict[];
  query: string;
  request: number;
  enqueue: (previous: PluginInfo | undefined, plugin: PluginInfo, plugins: PluginInfo[]) => void;
  dismiss: () => void;
  resolve: (keep: string) => Promise<void>;
  search: (query: string) => void;
  openSearch: (query: string) => void;
}
export const useShortcutConflicts = create<State>((set, get) => ({
  queue: [],
  query: "",
  request: 0,
  enqueue: (previous, plugin, plugins) => {
    const definitions = shortcutCommands(plugins);
    const old = shortcutCommands(previous ? [previous] : []);
    const overrides = useSettings.getState().settings.keyboardShortcuts ?? {};
    const incoming = definitions.filter(
      (item) => item.plugin?.id === plugin.id && item.plugin.command,
    );
    const pending: PendingShortcutConflict[] = [];
    for (const command of incoming) {
      for (const binding of bindingsFor(command.id, overrides, undefined, definitions)) {
        if (
          bindingsFor(command.id, overrides, undefined, old).some(
            (key) => displayShortcut(key) === displayShortcut(binding),
          )
        )
          continue;
        for (const other of shortcutConflicts(command.id, binding, overrides, definitions)) {
          // Don't prompt twice for two newly contributed commands in the same plugin.
          if (
            pending.some(
              (item) =>
                item.incoming === other.id &&
                item.existing === command.id &&
                displayShortcut(item.binding) === displayShortcut(binding),
            )
          )
            continue;
          pending.push({ incoming: command.id, existing: other.id, binding });
        }
      }
    }
    if (pending.length) set((state) => ({ queue: [...state.queue, ...pending] }));
  },
  dismiss: () => set((state) => ({ queue: state.queue.slice(1) })),
  resolve: async (keep) => {
    const conflict = get().queue[0];
    if (!conflict) return;
    const definitions = shortcutCommands(
      (await import("@/store/plugins")).usePlugins.getState().items,
    );
    const remove = keep === conflict.incoming ? conflict.existing : conflict.incoming;
    const settings = useSettings.getState();
    const overrides = settings.settings.keyboardShortcuts ?? {};
    const remaining = bindingsFor(remove, overrides, undefined, definitions).filter(
      (key) => displayShortcut(key) !== displayShortcut(conflict.binding),
    );
    if (await settings.update({ keyboardShortcuts: { ...overrides, [remove]: remaining } }))
      get().dismiss();
  },
  search: (query) => set({ query }),
  openSearch: (query) => set((state) => ({ query, request: state.request + 1 })),
}));
