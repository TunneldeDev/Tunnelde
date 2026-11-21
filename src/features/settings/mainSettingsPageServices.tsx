import { useShortcutConflicts } from "@/store/shortcutConflicts";
import { AboutPage } from "@/features/about/AboutPage";
import { MountHostDetailsSettings } from "@/features/plugins/MountHostDetailsSettings";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { UpdateStatus } from "./UpdateSettings";
import { useUpdates } from "@/store/updates";
import { useDialogs } from "@/store/dialogs";
import { useNavigation } from "@/store/navigation";
import { PluginSettingsSection } from "@/features/plugins/PluginSettingsSection";
import { PluginConfigurationSection } from "@/features/plugins/configuration/components/PluginConfigurationSection";
import { usePlugins } from "@/store/plugins";
import { UiProviderSettings } from "@/features/plugins/UiProviderSettings";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { SettingsProfiles } from "./SettingsProfiles";
import { NetworkSettingsSection } from "./NetworkSettings";
import { LogViewer } from "./LogViewer";
import { StorageSettings } from "./StorageSettings";
import { useViewState } from "@/lib/session/viewState";
import { PreferenceSurface } from "./components/PreferenceSurface";
import { mainPreferenceFieldsServices } from "./components/PreferenceFields";
import { PreferenceRow } from "./components/PreferenceRow";
import type { SettingsPageServices } from "./settingsPageServices";

export const mainSettingsPageServices: SettingsPageServices = {
  useData() {
    const settings = useSettings((s) => s.settings),
      info = useSettings((s) => s.info);
    const error = useSettings((s) => s.error),
      saving = useSettings((s) => s.saving);
    const plugins = usePlugins((s) => s.items);
    const updatesBusy = useUpdates(
      (s) => s.busy || s.state?.phase === "downloading" || s.state?.phase === "ready",
    );
    const section = useNavigation((s) => s.settingsSection),
      settingsRequest = useNavigation((s) => s.settingsRequest);
    const shortcutRequest = useShortcutConflicts((s) => s.request);
    return {
      settings,
      defaults: info?.defaultSettings ?? createDefaultSettings(info?.os),
      platform: info?.os ?? "",
      plugins,
      error,
      saving,
      updatesBusy,
      section,
      settingsRequest,
      shortcutRequest,
    };
  },
  useViewState,
  update: (patch) => useSettings.getState().update(patch),
  reset: () => useSettings.getState().reset(),
  confirm: (options) => useDialogs.getState().confirm(options),
  selectSection: (section) => useNavigation.getState().selectSettings(section),
  renderProfiles: (props) => <SettingsProfiles {...props} />,
  renderSpecial(section, options) {
    switch (section) {
      case "plugins":
        return <PluginSettingsSection />;
      case "about":
        return <AboutPage embedded />;
      case "updates":
        return <UpdateStatus />;
      case "uiProviders":
        return <UiProviderSettings expanded={options?.expanded} />;
      case "mountHostDetails":
        return <MountHostDetailsSettings />;
      case "network":
        return <NetworkSettingsSection />;
      case "shortcuts":
        return <KeyboardShortcuts />;
      case "storage":
        return <StorageSettings />;
      case "logs":
        return <LogViewer />;
    }
  },
  renderConfiguration: (props) => <PluginConfigurationSection {...props} />,
  renderPreferenceSurface: (props) => <PreferenceSurface {...props} />,
  renderProtectedRow: (props) => <PreferenceRow {...props} />,
  fields: mainPreferenceFieldsServices,
};
