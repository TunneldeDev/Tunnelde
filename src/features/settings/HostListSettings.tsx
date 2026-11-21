import { useSettings } from "@/store/settings";
import { defaultHostListPreferences } from "@/lib/hosts/columns";
import { HostListSettingsView } from "./components/HostListSettingsView";
export function HostListSettings() {
  const preferences = useSettings((state) => state.settings.hostList);
  return (
    <HostListSettingsView
      preferences={preferences}
      onViewChange={(view) => {
        const owner = useSettings.getState();
        void owner.update({ hostList: { ...owner.settings.hostList, view } });
      }}
      onReset={() => {
        const owner = useSettings.getState();
        void owner.update({
          hostList: { ...defaultHostListPreferences(), view: owner.settings.hostList.view },
        });
      }}
    />
  );
}
