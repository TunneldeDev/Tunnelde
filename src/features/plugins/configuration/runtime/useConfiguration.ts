import type { ConfigurationPlugin } from "../data/services";
import { useConfigurationModel } from "./useConfigurationModel";
import { mainConfigurationServices } from "./mainServices";
export function useConfiguration(plugin: ConfigurationPlugin, visible: boolean) {
  return useConfigurationModel(plugin, visible, mainConfigurationServices);
}
