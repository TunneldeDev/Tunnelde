import { api } from "@/lib/api/ipc";
import { useMarketplace } from "@/store/marketplace";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import { copyText } from "@/lib/session/clipboard";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { NodeRuntimeSection } from "./NodeRuntimeSection";
import { PluginSecuritySection } from "./PluginSecuritySection";
import { RunnerRecoverySection } from "./recovery/components/RunnerRecoverySection";
import {
  PluginSettingsSectionView,
  type PluginSourceServices,
} from "./components/PluginSettingsSectionView";
import { changePluginSources } from "./data/sourceMutations";
const services: PluginSourceServices = {
  useData() {
    const { config, configError, configLoading, ready } = useMarketplace();
    return { sources: config.sources, configError, configLoading, ready };
  },
  readSources: () => useMarketplace.getState().config.sources,
  load: (refresh) => useMarketplace.getState().load(refresh),
  change: async (command) => {
    const owner = useMarketplace.getState();
    if (!owner.ready || owner.configLoading) throw new Error("market.busy");
    await owner.saveSources(changePluginSources(owner.config.sources, command));
  },
  test: (url) => api.pluginSourceTest(url),
  confirm: (options) => useDialogs.getState().confirm(options),
  notify: toast,
  copyError: copyText,
  useViewState,
  useBusyGuard: useBackgroundGuard,
  renderSecurity: () => <PluginSecuritySection />,
  renderRecovery: () => <RunnerRecoverySection />,
  renderRuntime: () => <NodeRuntimeSection />,
};
export function PluginSettingsSection() {
  return <PluginSettingsSectionView services={services} />;
}
