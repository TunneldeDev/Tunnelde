import { pluginConfigurationApi } from "@/lib/api/plugins/configuration";
import { nativeEvents } from "@/lib/events/native";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { useDialogs } from "@/store/dialogs";
import type { ConfigurationServices } from "../data/services";
export const mainConfigurationServices: ConfigurationServices = {
  client: pluginConfigurationApi,
  observe: (changed, signal) => nativeEvents.on("plugin://configuration-changed", changed, signal),
  useViewState,
  useBusyGuard: useBackgroundGuard,
  confirm: (options) => useDialogs.getState().confirm(options),
};
