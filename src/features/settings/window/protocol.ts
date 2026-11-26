import type { HabitCategory, HabitDetail } from "@/lib/habits/types";
import type { ProxyProfile } from "@/lib/api/network";
import type { ReleaseHistory, SettingsPatch } from "@/lib/api/types";
import type { FontSelections, FontReference, FontCatalogue, FontInfo } from "@/lib/fonts/types";
import type { SettingsSection } from "@/store/navigation";
import type { ConfirmOptions } from "@/store/dialogs";
import type { SettingsProfilesServices } from "../components/SettingsProfilesView";
import type { NetworkSettingsServices } from "../components/NetworkSettingsView";
import type { NetworkConnectionTestServices } from "../components/NetworkConnectionTestView";
import type { StorageSettingsServices } from "../components/StorageSettingsView";
import type { KeyboardShortcutsServices } from "../components/KeyboardShortcutsView";
import type { PluginSourceServices } from "@/features/plugins/components/PluginSettingsSectionView";
import type { PluginSecurityServices } from "@/features/plugins/components/PluginSecuritySectionView";
import type { NodeRuntimeServices } from "@/features/plugins/components/NodeRuntimeSectionView";
import type { ConfigurationServices } from "@/features/plugins/configuration/data/services";
import type { RunnerRecoveryServices } from "@/features/plugins/recovery/data/services";
import type { FrontendProviderTarget } from "@/lib/extensions/contracts/frontend/providers";
import type { AboutLink } from "@/features/about/AboutPageView";
import type { ColorRegion } from "@/lib/api/types";
type Method<F> = F extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;
type Methods<S, K extends keyof S, P extends string> = {
  [M in K as `${P}${M & string}`]: Method<S[M]>;
};
/** Closed first-party owner effects, not arbitrary application IPC or store RPC. */
export type SettingsCalls = {
  habitsDetails: { args: [HabitCategory]; result: HabitDetail[] };
  habitsReset: { args: [HabitCategory[]]; result: void };
  preference: { args: [SettingsPatch]; result: boolean };
  reset: { args: []; result: void };
  section: { args: [SettingsSection]; result: void };
  confirm: { args: [Omit<ConfirmOptions, "onConfirm">]; result: boolean };
  clipboard: { args: [string]; result: void };
  showOutput: { args: []; result: void };
  externalLink: { args: [string]; result: void };
  aboutLink: { args: [AboutLink]; result: void };
  hostView: { args: ["tree" | "table"]; result: boolean };
  hostDefaults: { args: []; result: boolean };
  region: { args: [ColorRegion, string | null]; result: boolean };
  fonts_select: {
    args: [keyof FontSelections, FontReference | null];
    result: void;
  };
  fonts_catalogue: { args: [boolean?]; result: FontCatalogue };
  fonts_import: { args: []; result: FontInfo | null };
  fonts_remove: { args: [string]; result: void };
  cssImport: { args: []; result: string | null };
  cssExport: { args: [string]; result: string | null };
  updateCheck: { args: [boolean?]; result: void };
  updateInstall: { args: []; result: void };
  updateSkip: { args: []; result: void };
  updateHistory: { args: [boolean?]; result: void };
  releaseHistory: { args: []; result: ReleaseHistory };
  updateRelease: { args: []; result: void };
  provider: { args: [FrontendProviderTarget, string]; result: void };
  mountContributor: { args: [string]; result: void };
  storageRestart: { args: []; result: void };
  network_saveProfile: {
    args: [
      {
        profile: ProxyProfile;
        credential: { action: "keep" | "forget" | "save" };
      },
    ];
    result: { credentialError: unknown | null };
  };
} & Methods<
  SettingsProfilesServices,
  "load" | "refresh" | "save" | "saveCurrent" | "remove" | "apply" | "importFile" | "exportFile",
  "profile_"
> &
  Methods<
    NetworkSettingsServices,
    "setDefaultProxy" | "setFeatureProxy" | "removeProfile",
    "network_"
  > &
  Methods<NetworkConnectionTestServices, "test", "network_"> &
  Methods<
    StorageSettingsServices,
    "load" | "changeDraft" | "schedule" | "cancel" | "pick" | "open",
    "storage_"
  > &
  Methods<KeyboardShortcutsServices, "setQuery" | "toggleFilter" | "change", "shortcuts_"> &
  Methods<PluginSourceServices, "load" | "change" | "test", "sources_"> &
  Methods<
    PluginSecurityServices,
    "load" | "setRestricted" | "revoke" | "dismissRecovery",
    "security_"
  > &
  Methods<
    NodeRuntimeServices,
    "load" | "check" | "choose" | "allowSystem" | "install" | "cancel",
    "node_"
  > &
  Methods<
    ConfigurationServices["client"],
    keyof ConfigurationServices["client"],
    "configuration_"
  > &
  Methods<RunnerRecoveryServices["client"], keyof RunnerRecoveryServices["client"], "recovery_"> &
  Methods<Pick<RunnerRecoveryServices, "openLog">, "openLog", "recovery_"> & {
    recovery_browse: {
      args: [string, Parameters<ReturnType<RunnerRecoveryServices["useFiles"]>["browse"]>[0]];
      result: void;
    };
  };
export type SettingsOperation = keyof SettingsCalls;
export type SettingsWindowCommand = {
  [K in SettingsOperation]: { operation: K; args: SettingsCalls[K]["args"] };
}[SettingsOperation];
export type SettingsCall = <K extends SettingsOperation>(
  operation: K,
  ...args: SettingsCalls[K]["args"]
) => Promise<SettingsCalls[K]["result"]>;
export type SettingsHandlers = {
  [K in SettingsOperation]: (
    ...args: SettingsCalls[K]["args"]
  ) => SettingsCalls[K]["result"] | Promise<SettingsCalls[K]["result"]>;
};
