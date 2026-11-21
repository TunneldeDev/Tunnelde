import type { ComponentProps } from "react";
import { usePlugins } from "@/store/plugins";
import { PluginConfigurationSectionView } from "./PluginConfigurationSectionView";
import { mainConfigurationServices } from "../runtime/mainServices";
export function PluginConfigurationSection(
  props: Omit<ComponentProps<typeof PluginConfigurationSectionView>, "plugins" | "services">,
) {
  const plugins = usePlugins((s) => s.items).filter((p) => p.configuration);
  return (
    <PluginConfigurationSectionView
      {...props}
      plugins={plugins}
      services={mainConfigurationServices}
    />
  );
}
