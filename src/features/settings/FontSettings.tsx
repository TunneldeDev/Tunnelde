import { api, isTauri } from "@/lib/api/ipc";
import { activateFonts, previewFont } from "@/lib/fonts/runtime";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import { useLocalControlState } from "./components/controlState";
import { FontSettingsView, type FontSettingsServices } from "./components/FontSettingsView";

export const mainFontServices: FontSettingsServices = {
  catalogue: (refresh) =>
    isTauri() ? api.fontsCatalogue(refresh) : Promise.resolve({ version: 1, items: [] }),
  async importFile() {
    const staged = await api.fontsImport();
    if (!staged) return null;
    let committed = false;
    try {
      const preview = await previewFont(staged.font.reference, staged.token);
      try {
        const result = await api.fontsFinishImport(staged.token, true, preview.monospaced);
        committed = true;
        activateFonts(useSettings.getState().settings.fontSelections, true);
        return result;
      } finally {
        preview.dispose();
      }
    } finally {
      if (!committed) await api.fontsFinishImport(staged.token, false).catch(() => undefined);
    }
  },
  async remove(id) {
    await api.fontsRemove(id);
    // Native settings notifications normally arrive first; refresh also covers
    // a window whose subscription was being re-established during deletion.
    useSettings.getState().applyRemote(await api.settings());
  },
  async select(target, reference) {
    useSettings.getState().applyRemote(await api.fontsSelect(target, reference));
  },
  confirm: (options) => useDialogs.getState().confirm(options),
  useViewState: useLocalControlState,
};

export function FontSettings() {
  const settings = useSettings((state) => state.settings);
  return <FontSettingsView settings={settings} services={mainFontServices} />;
}
