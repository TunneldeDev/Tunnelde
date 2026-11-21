import { useMemo, type ComponentProps } from "react";
import { installedIconThemes } from "@/lib/files/icons";
import { usePlugins } from "@/store/plugins";
import { FileIconThemeSettingView } from "./components/FileIconThemeSettingView";
export function FileIconThemeSetting(
  props: Omit<ComponentProps<typeof FileIconThemeSettingView>, "themes">,
) {
  const plugins = usePlugins((state) => state.items);
  const themes = useMemo(() => installedIconThemes(plugins), [plugins]);
  return <FileIconThemeSettingView {...props} themes={themes} />;
}
