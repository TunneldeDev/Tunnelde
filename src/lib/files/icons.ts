import { useMemo } from "react";
import type { PluginInfo, PluginFileIcon, PluginFileIconTheme } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";

export function installedIconThemes(plugins: PluginInfo[]) {
  return plugins
    .flatMap((plugin) =>
      (plugin.fileIconThemes ?? []).map((theme) => ({
        id: `${plugin.id}:${theme.id}`,
        name: theme.name,
        plugin: plugin.name,
        theme,
      })),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type FileIconResolver = (name: string) => PluginFileIcon | undefined;

/** Compile maps once per theme change; row rendering does not scan plugin manifests. */
export function createFileIconResolver(theme?: PluginFileIconTheme): FileIconResolver {
  if (!theme) return () => undefined;
  const names = new Map(
    Object.entries(theme.fileNames ?? {}).map(([key, icon]) => [key.toLowerCase(), icon]),
  );
  const extensions = new Map(
    Object.entries(theme.extensions ?? {}).map(([key, icon]) => [key.toLowerCase(), icon]),
  );
  return (name) => {
    const base = name.split(/[\\/]/).pop()!.toLowerCase();
    let icon = names.get(base);
    if (!icon) {
      // Prefer compound extensions such as tar.gz before trying gz.
      for (let dot = base.indexOf("."); dot >= 0; dot = base.indexOf(".", dot + 1)) {
        if (dot === 0) continue;
        icon = extensions.get(base.slice(dot + 1));
        if (icon) break;
      }
    }
    return theme.icons[icon ?? theme.defaultIcon ?? ""];
  };
}

export function useFileIconResolver(): FileIconResolver {
  const plugins = usePlugins((state) => state.items);
  const selected = useSettings((state) => state.settings.fileIconTheme);
  return useMemo(() => {
    const themes = installedIconThemes(plugins);
    const theme = selected === "auto" ? themes[0] : themes.find((theme) => theme.id === selected);
    return createFileIconResolver(selected === "none" ? undefined : theme?.theme);
  }, [plugins, selected]);
}
