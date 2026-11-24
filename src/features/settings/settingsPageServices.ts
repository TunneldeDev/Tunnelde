import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import type { Settings, SettingsPatch, PluginInfo } from "@/lib/api/types";
import type { SettingsSection } from "@/store/navigation";
import type { ConfirmOptions } from "@/store/dialogs";
import type { PreferenceFieldsServices } from "./components/PreferenceFieldsView";
import type { PreferenceRowProps } from "./components/PreferenceRow";
import type { PreferenceSurface } from "./components/PreferenceSurface";
export interface SettingsPageData {
  settings: Settings;
  defaults: Settings;
  platform: string;
  plugins: Pick<PluginInfo, "id" | "name" | "configuration">[];
  error: string | null;
  saving: boolean;
  updatesBusy: boolean;
  section: SettingsSection;
  settingsRequest: number;
  shortcutRequest: number;
}
export type SettingsSpecialSection =
  | "plugins"
  | "about"
  | "updates"
  | "uiProviders"
  | "mountHostDetails"
  | "network"
  | "shortcuts"
  | "storage"
  | "logs"
  | "habits";
/** Document-local view services, not a serializable IPC or whole-store proxy.
 * A native owner must implement every section/effect before admitting a page. */
export interface SettingsPageServices {
  useData(): SettingsPageData;
  useViewState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>];
  update(patch: SettingsPatch): Promise<boolean>;
  reset(): Promise<void>;
  confirm(options: ConfirmOptions): void;
  selectSection(section: SettingsSection): void;
  renderProfiles(props: { hasDraft: boolean; onApplied(): void }): ReactNode;
  renderSpecial(section: SettingsSpecialSection, options?: { expanded?: boolean }): ReactNode;
  renderConfiguration(props: { query: string; hidden: boolean; visible: boolean }): ReactNode;
  renderPreferenceSurface(props: ComponentProps<typeof PreferenceSurface>): ReactNode;
  renderProtectedRow(props: PreferenceRowProps): ReactNode;
  fields: PreferenceFieldsServices;
}
