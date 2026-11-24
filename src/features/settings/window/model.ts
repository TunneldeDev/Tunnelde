import type { HabitsData } from "@/lib/habits/types";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import type { SettingsPageData } from "../settingsPageServices";
import type { SettingsProfilesData } from "../components/SettingsProfilesView";
import type { StorageSettingsData } from "../components/StorageSettingsView";
import type { KeyboardShortcutsData } from "../components/KeyboardShortcutsView";
import type { PluginSourceServices } from "@/features/plugins/components/PluginSettingsSectionView";
import type { PluginSecurityData } from "@/features/plugins/components/PluginSecuritySectionView";
import type { NodeRuntimeData } from "@/features/plugins/components/NodeRuntimeSectionView";
import type { ProviderSettingsRow } from "@/features/plugins/components/UiProviderSettingsView";
import type { AppInfo, PluginInfo, UpdateState } from "@/lib/api/types";
import type { UpdateHistoryProjection } from "../components/UpdateNotesView";
export interface SettingsProjection {
  habits?: HabitsData;
  page: SettingsPageData;
  profiles: SettingsProfilesData;
  storage: StorageSettingsData;
  shortcuts: KeyboardShortcutsData;
  sources: ReturnType<PluginSourceServices["useData"]>;
  security: PluginSecurityData;
  node: NodeRuntimeData;
  providers: { rows: ProviderSettingsRow[]; busy: boolean };
  mountContributor: {
    value: string;
    candidates: { value: string; label: string }[];
    unavailableName: string;
    busy: boolean;
  };
  recoveryFiles: { pending: boolean; error: string | null };
  /** Metadata/appearance only; no activation tokens, saved credentials or secret drafts. */
  plugins: PluginInfo[];
  info: Pick<AppInfo, "version" | "tauriVersion" | "os" | "arch"> | null;
  update: { state: UpdateState | null; busy: boolean; history: UpdateHistoryProjection | null };
  configurationChanges: { pluginId: string; revision: string }[];
}
export interface SettingsWindowModel extends WindowModelAppearance {
  settings: SettingsProjection;
}
