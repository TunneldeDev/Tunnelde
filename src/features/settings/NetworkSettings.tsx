import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { defaultNetwork } from "@/lib/api/network";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { NetworkSettingsView } from "./components/NetworkSettingsView";
import { NetworkConnectionTest } from "./NetworkConnectionTest";
import { changeNetworkRoute } from "./data/networkMutations";

export function NetworkSettingsSection() {
  const settings = useSettings((s) => s.settings.network) ?? defaultNetwork();
  const plugins = usePlugins((s) => s.items);
  const mutate = (change: Parameters<typeof changeNetworkRoute>[1]) => {
    const owner = useSettings.getState();
    return owner.update({
      network: changeNetworkRoute(owner.settings.network ?? defaultNetwork(), change),
    });
  };
  return (
    <NetworkSettingsView
      settings={settings}
      plugins={plugins}
      services={{
        useViewState,
        // Existing background memory handoff remains main-owned; never persist in layout.
        useSecretState: useViewState,
        useBusyGuard: useBackgroundGuard,
        setDefaultProxy: (value) => mutate({ kind: "default", value }),
        setFeatureProxy: (feature, value) => mutate({ kind: "feature", feature, value }),
        removeProfile: (id) => mutate({ kind: "remove", id }),
        saveProfile: async (edit) => {
          const { credentialError } = await useSettings.getState().saveProxyProfile(edit);
          return { credentialError };
        },
        renderConnectionTest: (network) => <NetworkConnectionTest settings={network} />,
      }}
    />
  );
}
