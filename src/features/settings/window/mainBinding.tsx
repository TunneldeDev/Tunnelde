import type { NetworkSettingsServices } from "../components/NetworkSettingsView";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { api } from "@/lib/api/ipc";
import { useSettings } from "@/store/settings";
import { useUpdates, matchingUpdateState, updateHistoryKey } from "@/store/updates";
import { useNavigation } from "@/store/navigation";
import { usePlugins } from "@/store/plugins";
import type { ConfirmOptions } from "@/store/dialogs";
import { confirmSettingsInMain } from "./confirmation";
import { useRestartPrompt } from "@/store/restartPrompt";
import { mainSettingsPageServices } from "../mainSettingsPageServices";
import { mainSettingsProfilesServices } from "../SettingsProfiles";
import { mainStorageSettingsServices } from "../StorageSettings";
import { mainKeyboardShortcutsServices } from "../KeyboardShortcuts";
import { mainPluginSourceServices } from "@/features/plugins/PluginSettingsSection";
import { mainPluginSecurityServices } from "@/features/plugins/PluginSecuritySection";
import { mainNodeRuntimeServices } from "@/features/plugins/NodeRuntimeSection";
import { useMainUiProviderSettings } from "@/features/plugins/UiProviderSettings";
import { useMainMountHostDetailsSettings } from "@/features/plugins/MountHostDetailsSettings";
import { mainConfigurationServices } from "@/features/plugins/configuration/runtime/mainServices";
import { runnerRecoveryApi } from "@/lib/api/runners/recovery";
import { useRecoveryFiles } from "@/features/plugins/recovery/runtime/useRecoveryFiles";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { defaultHostListPreferences } from "@/lib/hosts/columns";
import { changeNetworkRoute } from "../data/networkMutations";
import { defaultNetwork } from "@/lib/api/network";
import { translateError } from "@/lib/api/errors";
import type { SettingsHandlers, SettingsWindowCommand } from "./protocol";
import type { SettingsProjection } from "./model";
import { create } from "zustand";

type OwnerHandlers = Omit<SettingsHandlers, "network_saveProfile" | "confirm"> & {
  confirm: (options: Omit<ConfirmOptions, "onConfirm">, signal?: AbortSignal) => Promise<boolean>;
  network_saveProfile: NetworkSettingsServices["saveProfile"];
};

/** In-memory main owner only. Never exposed through the plugin frontend runtime. */
export const useSettingsOwner = create<{
  identity: object | null;
  projection: SettingsProjection | null;
  handlers: OwnerHandlers | null;
}>(() => ({ identity: null, projection: null, handlers: null }));
export async function executeSettingsCommand(
  command: SettingsWindowCommand,
  readPassword: () => Promise<string>,
  signal?: AbortSignal,
) {
  const owner = useSettingsOwner.getState();
  const handlers = owner.handlers;
  if (
    !handlers ||
    !Object.prototype.hasOwnProperty.call(handlers, command.operation) ||
    !Array.isArray(command.args)
  )
    throw new Error("panel.window.staleOwner");
  // The native control plane has already fenced the exact settings lease and
  // closed operation name. Each owner/API still validates its concrete input.
  try {
    signal?.throwIfAborted();
    if (command.operation === "confirm") return await handlers.confirm(command.args[0], signal);
    if (command.operation === "network_saveProfile") {
      const [edit] = command.args;
      if (
        !edit ||
        !["keep", "forget", "save"].includes(edit.credential?.action) ||
        Object.keys(edit.credential).some((key) => key !== "action")
      )
        throw new Error("panel.window.staleOwner");
      const password = edit.credential.action === "save" ? await readPassword() : "";
      signal?.throwIfAborted();
      if (
        !useSettingsOwner.getState().handlers ||
        useSettingsOwner.getState().identity !== owner.identity
      )
        throw new Error("panel.window.staleOwner");
      return await handlers.network_saveProfile({
        profile: edit.profile,
        credential:
          edit.credential.action === "save"
            ? { action: "save", password }
            : { action: edit.credential.action },
      });
    }
    return await (handlers[command.operation] as (...args: never[]) => unknown)(
      ...(command.args as never[]),
    );
  } catch (error) {
    throw new Error(translateError(error));
  }
}
/** Stays in main across every presentation move. Authentication and real effect
 * hooks outlive the renderer, but close with the actual Settings owner. */
export function SettingsWindowOwner({ show }: { show: () => Promise<unknown> }) {
  const [lifetime] = useState(() => {
    let controller = new AbortController();
    return {
      start() {
        if (controller.signal.aborted) controller = new AbortController();
        return () => controller.abort();
      },
      signal: () => controller.signal,
    };
  });
  useLayoutEffect(() => lifetime.start(), [lifetime]);
  const page = mainSettingsPageServices.useData();
  const profiles = mainSettingsProfilesServices.useData();
  const storage = mainStorageSettingsServices.useData();
  const shortcuts = mainKeyboardShortcutsServices.useData();
  const sources = mainPluginSourceServices.useData();
  const security = mainPluginSecurityServices.useData();
  const node = mainNodeRuntimeServices.useData();
  const providers = useMainUiProviderSettings(),
    mountContributor = useMainMountHostDetailsSettings();
  const files = useRecoveryFiles("");
  const browseRecovery = files.browse;
  const plugins = usePlugins((s) => s.items),
    info = useSettings((s) => s.info);
  const update = useUpdates();
  const [configurationChanges, setConfigurationChanges] = useState<
    { pluginId: string; revision: string }[]
  >([]);
  useEffect(() => {
    const controller = new AbortController();
    void mainConfigurationServices.observe(
      (next) =>
        setConfigurationChanges((previous) => [
          ...previous.filter((p) => p.pluginId !== next.pluginId),
          next,
        ]),
      controller.signal,
    );
    return () => controller.abort();
  }, []);
  const projection: SettingsProjection = {
    page,
    profiles,
    storage,
    shortcuts,
    sources,
    security,
    node,
    providers: { rows: providers.rows, busy: providers.busy },
    mountContributor: {
      value: mountContributor.value,
      candidates: mountContributor.candidates,
      unavailableName: mountContributor.unavailableName,
      busy: mountContributor.busy,
    },
    recoveryFiles: { pending: files.pending, error: files.error },
    plugins,
    info: info
      ? { version: info.version, tauriVersion: info.tauriVersion, os: info.os, arch: info.arch }
      : null,
    update: {
      state: matchingUpdateState(update.state, page.settings),
      busy: update.busy,
      history:
        update.state && update.history?.key === updateHistoryKey(update.state)
          ? update.history
          : null,
    },
    configurationChanges,
  };
  const handlers: OwnerHandlers = useMemo(
    () => ({
      preference: (patch) => useSettings.getState().update(patch),
      reset: () => useSettings.getState().reset(),
      section: (section) => useNavigation.getState().selectSettings(section),
      confirm: async (options, signal) => {
        const owner = lifetime.signal();
        return confirmSettingsInMain(
          options,
          show,
          signal ? AbortSignal.any([signal, owner]) : owner,
        );
      },
      clipboard: (text) => api.clipboardWriteText(text),
      showOutput: async () => {
        await show();
        useNavigation.getState().showOutput();
      },
      externalLink: (value) => {
        const url = new URL(value);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          value.length > 8192
        )
          throw new Error("panel.window.staleOwner");
        return api.openExternal(url.href);
      },
      aboutLink: (link) => {
        const links = {
          source: "https://github.com/TunneldeDev/Tunnelde",
          license: "https://github.com/TunneldeDev/Tunnelde/blob/main/LICENSE",
          notices: "https://github.com/TunneldeDev/Tunnelde/blob/main/THIRD_PARTY_NOTICES.md",
        };
        if (!Object.prototype.hasOwnProperty.call(links, link))
          throw new Error("panel.window.staleOwner");
        return api.openExternal(links[link]);
      },
      hostView: (view) => {
        const owner = useSettings.getState();
        return owner.update({ hostList: { ...owner.settings.hostList, view } });
      },
      hostDefaults: () => {
        const owner = useSettings.getState();
        return owner.update({
          hostList: { ...defaultHostListPreferences(), view: owner.settings.hostList.view },
        });
      },
      region: (region, value) => {
        const owner = useSettings.getState();
        const colors = { ...owner.settings.colors };
        if (value) colors[region] = value;
        else delete colors[region];
        return owner.update({ colors });
      },
      cssImport: () => api.importCss(),
      cssExport: (text) => api.exportCss(text),
      updateCheck: (force) => useUpdates.getState().check(force),
      updateInstall: () => useUpdates.getState().install(),
      updateSkip: () => useUpdates.getState().skip(),
      updateHistory: (retry) => useUpdates.getState().loadHistory(retry),
      updateRelease: () => api.openReleasePage(),
      provider: providers.choose,
      mountContributor: mountContributor.choose,
      storageRestart: async () => {
        await show();
        lifetime.signal().throwIfAborted();
        useRestartPrompt.getState().show();
      },
      profile_load: mainSettingsProfilesServices.load,
      profile_refresh: mainSettingsProfilesServices.refresh,
      profile_save: mainSettingsProfilesServices.save,
      profile_saveCurrent: mainSettingsProfilesServices.saveCurrent,
      profile_remove: mainSettingsProfilesServices.remove,
      profile_apply: mainSettingsProfilesServices.apply,
      profile_importFile: mainSettingsProfilesServices.importFile,
      profile_exportFile: mainSettingsProfilesServices.exportFile,
      network_setDefaultProxy: (value) => {
        const owner = useSettings.getState();
        return owner.update({
          network: changeNetworkRoute(owner.settings.network ?? defaultNetwork(), {
            kind: "default",
            value,
          }),
        });
      },
      network_setFeatureProxy: (feature, value) => {
        const owner = useSettings.getState();
        return owner.update({
          network: changeNetworkRoute(owner.settings.network ?? defaultNetwork(), {
            kind: "feature",
            feature,
            value,
          }),
        });
      },
      network_removeProfile: (id) => {
        const owner = useSettings.getState();
        return owner.update({
          network: changeNetworkRoute(owner.settings.network ?? defaultNetwork(), {
            kind: "remove",
            id,
          }),
        });
      },
      network_saveProfile: async (edit) => {
        const { credentialError } = await useSettings.getState().saveProxyProfile(edit);
        return {
          credentialError: credentialError == null ? null : translateError(credentialError),
        };
      },
      network_test: (proxy, host, port) => api.testProxyQuality(proxy, host, port),
      storage_load: mainStorageSettingsServices.load,
      storage_changeDraft: mainStorageSettingsServices.changeDraft,
      storage_schedule: mainStorageSettingsServices.schedule,
      storage_cancel: mainStorageSettingsServices.cancel,
      storage_pick: mainStorageSettingsServices.pick,
      storage_open: mainStorageSettingsServices.open,
      shortcuts_setQuery: mainKeyboardShortcutsServices.setQuery,
      shortcuts_toggleFilter: mainKeyboardShortcutsServices.toggleFilter,
      shortcuts_change: mainKeyboardShortcutsServices.change,
      sources_load: mainPluginSourceServices.load,
      sources_change: mainPluginSourceServices.change,
      sources_test: mainPluginSourceServices.test,
      security_load: mainPluginSecurityServices.load,
      security_setRestricted: mainPluginSecurityServices.setRestricted,
      security_revoke: mainPluginSecurityServices.revoke,
      security_dismissRecovery: mainPluginSecurityServices.dismissRecovery,
      node_load: mainNodeRuntimeServices.load,
      node_check: mainNodeRuntimeServices.check,
      node_choose: mainNodeRuntimeServices.choose,
      node_allowSystem: mainNodeRuntimeServices.allowSystem,
      node_install: mainNodeRuntimeServices.install,
      node_cancel: mainNodeRuntimeServices.cancel,
      configuration_get: mainConfigurationServices.client.get,
      configuration_update: mainConfigurationServices.client.update,
      configuration_migrate: mainConfigurationServices.client.migrate,
      configuration_backups: mainConfigurationServices.client.backups,
      configuration_restore: mainConfigurationServices.client.restore,
      configuration_deleteBackup: mainConfigurationServices.client.deleteBackup,
      recovery_owners: runnerRecoveryApi.owners,
      recovery_snapshot: runnerRecoveryApi.snapshot,
      recovery_action: runnerRecoveryApi.action,
      recovery_openLog: async () => {
        await show();
        lifetime.signal().throwIfAborted();
        await api.openLatestLog();
      },
      recovery_browse: async (pluginId, entry) => {
        await show();
        lifetime.signal().throwIfAborted();
        await browseRecovery(entry, pluginId);
      },
    }),
    [show, providers.choose, mountContributor.choose, browseRecovery, lifetime],
  );
  useLayoutEffect(() => {
    useSettingsOwner.setState({ identity: lifetime, projection, handlers });
  });
  useLayoutEffect(
    () => () => useSettingsOwner.setState({ identity: null, projection: null, handlers: null }),
    [],
  );
  return files.connection ? (
    <ConnectDialog
      host={files.connection.host}
      after="background"
      verification={files.verification}
      connectSession={files.connect}
      onConnected={files.connected}
      onClose={files.cancel}
    />
  ) : null;
}
