import { useMemo } from "react";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import { useShortcutConflicts } from "@/store/shortcutConflicts";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { shortcutCommands } from "@/lib/keyboard/registry";
import { toggleShortcutFilter } from "@/lib/keyboard/query";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";
import {
  KeyboardShortcutsView,
  type KeyboardShortcutsServices,
} from "./components/KeyboardShortcutsView";
import { changeShortcutSettings } from "./data/shortcutMutations";
const EMPTY = {};
export const mainKeyboardShortcutsServices: KeyboardShortcutsServices = {
  useData() {
    const plugins = usePlugins((s) => s.items);
    const definitions = useMemo(() => shortcutCommands(plugins), [plugins]);
    const settings = useSettings((s) => s.settings),
      saving = useSettings((s) => s.saving);
    const query = useShortcutConflicts((s) => s.query);
    return {
      plugins,
      definitions,
      overrides: settings.keyboardShortcuts ?? EMPTY,
      rules: settings.shortcutRules ?? EMPTY,
      showDetails: settings.showShortcutDetails ?? false,
      saving,
      query,
    };
  },
  useViewState,
  useBusyGuard: useBackgroundGuard,
  setQuery: (query) => useShortcutConflicts.getState().search(query),
  toggleFilter: (key, value) => {
    const owner = useShortcutConflicts.getState();
    owner.search(toggleShortcutFilter(owner.query, key, value));
  },
  change: (change) => {
    const owner = useSettings.getState();
    if (owner.saving) return Promise.resolve(false);
    const patch = changeShortcutSettings(
      owner.settings,
      shortcutCommands(usePlugins.getState().items),
      change,
    );
    if (!patch) {
      toast(i18n.t("shortcuts.changed"), "error");
      return Promise.resolve(false);
    }
    return owner.update(patch);
  },
  confirm: (options) => useDialogs.getState().confirm(options),
};
export function KeyboardShortcuts() {
  return <KeyboardShortcutsView services={mainKeyboardShortcutsServices} />;
}
