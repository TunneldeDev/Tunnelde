import { useEffect } from "react";
import type { Settings } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { RegionColorsView } from "./components/RegionColorsView";

export function RegionColors({ settings }: { settings: Settings }) {
  const plugins = usePlugins((state) => state.items);
  const load = usePlugins((state) => state.load);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <RegionColorsView
      settings={settings}
      plugins={plugins}
      services={{
        applyTheme: (patch) => useSettings.getState().update(patch),
        changeRegion: (region, value) => {
          const owner = useSettings.getState();
          const colors = { ...owner.settings.colors };
          if (value) colors[region] = value;
          else delete colors[region];
          void owner.update({ colors });
        },
      }}
    />
  );
}
