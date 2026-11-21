import type { NetworkSettings } from "@/lib/api/network";
import { api } from "@/lib/api/ipc";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { NetworkConnectionTestView } from "./components/NetworkConnectionTestView";
export function NetworkConnectionTest({ settings }: { settings: NetworkSettings }) {
  return (
    <NetworkConnectionTestView
      settings={settings}
      services={{
        test: (proxy, host, port) => api.testProxyQuality(proxy, host, port),
        useBusyGuard: useBackgroundGuard,
      }}
    />
  );
}
