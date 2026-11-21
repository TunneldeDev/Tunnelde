import type { PluginInfo } from "@/lib/api/types";
import type { SettingsControlState } from "@/features/settings/components/controlState";
import type { ConfirmOptions } from "@/store/dialogs";
import type { pluginConfigurationApi } from "@/lib/api/plugins/configuration";
export type ConfigurationPlugin = Pick<PluginInfo, "id" | "name" | "fingerprint" | "configuration">;
/** Document-local effects; native adapters must bind IDs/fingerprints to canonical owners. */
export interface ConfigurationServices {
  client: typeof pluginConfigurationApi;
  observe(
    changed: (event: { pluginId: string; revision: string }) => void,
    signal: AbortSignal,
  ): Promise<unknown>;
  useViewState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
  confirm(options: ConfirmOptions): void;
}
