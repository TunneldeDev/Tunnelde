import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import { SettingsPageView } from "../SettingsPageView";
import type { SettingsPageServices, SettingsSpecialSection } from "../settingsPageServices";
import { PreferenceRowView } from "../components/PreferenceRowView";
import {
  PreferenceSurfaceView,
  type PreferenceSurfaceServices,
} from "../components/PreferenceSurfaceView";
import { RegionColorsView } from "../components/RegionColorsView";
import { FileIconThemeSettingView } from "../components/FileIconThemeSettingView";
import { HostListSettingsView } from "../components/HostListSettingsView";
import { CssEditorView } from "../components/CssEditorView";
import { UpdateSourceUrlView } from "../components/UpdateSourceUrlView";
import { UpdateStatusView } from "../components/UpdateStatusView";
import { UpdateNotesView } from "../components/UpdateNotesView";
import { UpdateDiagnosticsView } from "../components/UpdateDiagnosticsView";
import { StorageSettingsView } from "../components/StorageSettingsView";
import { SettingsProfilesView } from "../components/SettingsProfilesView";
import { NetworkSettingsView } from "../components/NetworkSettingsView";
import { NetworkConnectionTestView } from "../components/NetworkConnectionTestView";
import { KeyboardShortcutsView } from "../components/KeyboardShortcutsView";
import { LogSettingsView } from "../components/LogSettingsView";
import { AboutPageView } from "@/features/about/AboutPageView";
import { PluginSettingsSectionView } from "@/features/plugins/components/PluginSettingsSectionView";
import { PluginSecuritySectionView } from "@/features/plugins/components/PluginSecuritySectionView";
import { NodeRuntimeSectionView } from "@/features/plugins/components/NodeRuntimeSectionView";
import { UiProviderSettingsView } from "@/features/plugins/components/UiProviderSettingsView";
import { MountHostDetailsSettingsView } from "@/features/plugins/components/MountHostDetailsSettingsView";
import { PluginConfigurationSectionView } from "@/features/plugins/configuration/components/PluginConfigurationSectionView";
import { RunnerRecoverySectionView } from "@/features/plugins/recovery/components/RunnerRecoverySectionView";
import { PluginMarkdownView } from "@/features/plugins/components/PluginMarkdownView";
import { TerminalPreview } from "@/features/terminal/TerminalPreview";
import { terminalPreferenceProjection } from "@/features/terminal/terminalViewServices";
import type { SettingsProjection } from "./model";
import type { SettingsCalls, SettingsOperation } from "./protocol";
import type { NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { createSettingsWindowAdapter } from "./adapter";
import {
  useSettingsBusyGuard,
  useSettingsControlState,
  useSettingsSecretState,
  useSettingsControlRegistry,
  useSettingsPrivatePassword,
} from "./SettingsDraftScope";
import type { ConfirmOptions } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
const Context = createContext<SettingsProjection | null>(null);
const useData = () => {
  const data = useContext(Context);
  if (!data) throw new Error("panel.window.staleOwner");
  return data;
};
type Adapter = ReturnType<typeof createSettingsWindowAdapter>;
function composition(
  adapter: Adapter,
  Provider: PreferenceSurfaceServices["Provider"],
): SettingsPageServices {
  // Component services survive every model publication. In particular load()
  // identities must not change and retrigger backend probes after each result.
  const methods = new Map<SettingsOperation, unknown>();
  const method = <K extends SettingsOperation>(name: K) => {
    type Handler = (...args: SettingsCalls[K]["args"]) => Promise<SettingsCalls[K]["result"]>;
    let handler = methods.get(name) as Handler | undefined;
    if (!handler) {
      handler = (...args) => adapter.call(name, ...args);
      methods.set(name, handler);
    }
    return handler;
  };
  const notify = (message: string, kind: "success" | "error") => toast(message, kind);
  const effect = <K extends SettingsOperation>(name: K, ...args: SettingsCalls[K]["args"]) => {
    void adapter.call(name, ...args).catch((error) => notify(translateError(error), "error"));
  };
  const confirm = (options: ConfirmOptions) => {
    const { onConfirm, ...description } = options;
    void adapter
      .call("confirm", description)
      .then((accepted) => (accepted ? onConfirm() : undefined))
      .catch((error) => notify(translateError(error), "error"));
  };
  const capture = { useViewState: useSettingsControlState, useBusyGuard: useSettingsBusyGuard };
  function Row(props: ComponentProps<SettingsPageServices["renderProtectedRow"]>) {
    const data = useData();
    return (
      <PreferenceRowView
        {...props}
        services={{
          update: method("preference"),
          updatesBusy: data.page.updatesBusy,
          useViewState: useSettingsControlState,
          renderColors: (settings) => (
            <RegionColorsView
              settings={settings}
              plugins={data.plugins}
              services={{
                applyTheme: method("preference"),
                changeRegion: (region, value) => effect("region", region, value),
              }}
            />
          ),
          renderFileIcons: (props) => (
            <FileIconThemeSettingView
              {...props}
              themes={data.plugins
                .flatMap((plugin) =>
                  (plugin.fileIconThemes ?? []).map((theme) => ({
                    id: `${plugin.id}:${theme.id}`,
                    name: theme.name,
                    plugin: plugin.name,
                  })),
                )
                .sort((a, b) => a.id.localeCompare(b.id))}
            />
          ),
        }}
      />
    );
  }
  function Profiles(props: { hasDraft: boolean; onApplied(): void }) {
    return (
      <SettingsProfilesView
        {...props}
        services={{
          ...capture,
          useData: () => useData().profiles,
          readCurrent: () => adapter.current().profiles,
          load: method("profile_load"),
          refresh: method("profile_refresh"),
          save: method("profile_save"),
          saveCurrent: method("profile_saveCurrent"),
          remove: method("profile_remove"),
          apply: method("profile_apply"),
          importFile: method("profile_importFile"),
          exportFile: method("profile_exportFile"),
          confirm,
          notify,
        }}
      />
    );
  }
  function Css(props: {
    draft: string | null;
    onDraft: ComponentProps<typeof CssEditorView>["onDraft"];
  }) {
    return (
      <CssEditorView
        {...props}
        value={useData().page.settings.userCss}
        services={{
          update: method("preference"),
          importFile: method("cssImport"),
          exportFile: method("cssExport"),
          notify,
          canTransferFiles: true,
        }}
      />
    );
  }
  function HostList() {
    const data = useData();
    return (
      <HostListSettingsView
        preferences={data.page.settings.hostList}
        onViewChange={(view) => effect("hostView", view)}
        onReset={() => effect("hostDefaults")}
      />
    );
  }
  function UpdateSource(props: { onReset(): void }) {
    const { page } = useData();
    return (
      <UpdateSourceUrlView
        {...props}
        value={page.settings.updateSourceUrl}
        source={page.settings.updateSource}
        saving={page.saving}
        update={method("preference")}
        updatesBusy={page.updatesBusy}
        useViewState={useSettingsControlState}
      />
    );
  }
  function Updates() {
    const data = useData();
    return (
      <UpdateStatusView
        settings={data.page.settings}
        version={data.info?.version}
        saving={data.page.saving}
        state={data.update.state}
        busy={data.update.busy}
        nativeAvailable
        services={{
          check: method("updateCheck"),
          install: method("updateInstall"),
          skip: method("updateSkip"),
          openRelease: () => effect("updateRelease"),
          renderDiagnostics: (failures) => (
            <UpdateDiagnosticsView
              failures={failures}
              onConfigureProxy={() => effect("section", "network")}
              onShowLogs={() => effect("showOutput")}
            />
          ),
          renderNotes: (state) => (
            <UpdateNotesView
              state={state}
              history={data.update.history}
              services={{
                load: method("updateHistory"),
                useViewState: useSettingsControlState,
                renderMarkdown: (source) => (
                  <PluginMarkdownView
                    source={source}
                    openLink={(url) => effect("externalLink", url)}
                  />
                ),
              }}
            />
          ),
        }}
      />
    );
  }
  function Preview() {
    const source = useMemo(
      () => ({
        read: () => terminalPreferenceProjection(adapter.current().page.settings),
        subscribe: adapter.subscribe,
      }),
      [],
    );
    return <TerminalPreview source={source} />;
  }
  function Security() {
    return (
      <PluginSecuritySectionView
        services={{
          ...capture,
          useData: () => useData().security,
          load: method("security_load"),
          setRestricted: method("security_setRestricted"),
          revoke: method("security_revoke"),
          dismissRecovery: () => effect("security_dismissRecovery"),
          copyError: (text) => effect("clipboard", text),
        }}
      />
    );
  }
  function Node() {
    return (
      <NodeRuntimeSectionView
        services={{
          useData: () => useData().node,
          useBusyGuard: useSettingsBusyGuard,
          load: method("node_load"),
          check: method("node_check"),
          choose: method("node_choose"),
          allowSystem: method("node_allowSystem"),
          install: method("node_install"),
          cancel: method("node_cancel"),
          confirm,
        }}
      />
    );
  }
  function Recovery() {
    const data = useData();
    return (
      <RunnerRecoverySectionView
        services={{
          ...capture,
          client: recoveryClient,
          openLog: method("recovery_openLog"),
          useFiles: (pluginId) => ({
            ...data.recoveryFiles,
            browse: (entry) => adapter.call("recovery_browse", pluginId, entry),
            renderConnection: () => null,
          }),
        }}
      />
    );
  }
  const recoveryClient = {
    owners: method("recovery_owners"),
    snapshot: method("recovery_snapshot"),
    action: method("recovery_action"),
  };
  const configuration = {
    ...capture,
    confirm,
    client: {
      get: method("configuration_get"),
      update: method("configuration_update"),
      migrate: method("configuration_migrate"),
      backups: method("configuration_backups"),
      restore: method("configuration_restore"),
      deleteBackup: method("configuration_deleteBackup"),
    },
    observe: async (
      receive: (event: { pluginId: string; revision: string }) => void,
      signal: AbortSignal,
    ) => {
      const seen = new Map(
        adapter.current().configurationChanges.map((event) => [event.pluginId, event.revision]),
      );
      const stop = adapter.subscribe(() => {
        if (signal.aborted) return;
        for (const event of adapter.current().configurationChanges)
          if (seen.get(event.pluginId) !== event.revision) {
            seen.set(event.pluginId, event.revision);
            receive(event);
          }
      });
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    },
  };
  function Plugins() {
    return (
      <PluginSettingsSectionView
        services={{
          ...capture,
          useData: () => useData().sources,
          readSources: () => adapter.current().sources.sources,
          load: method("sources_load"),
          change: method("sources_change"),
          test: method("sources_test"),
          confirm,
          notify,
          copyError: (text) => effect("clipboard", text),
          renderSecurity: () => <Security />,
          renderRecovery: () => <Recovery />,
          renderRuntime: () => <Node />,
        }}
      />
    );
  }
  function Network() {
    const data = useData();
    return (
      <NetworkSettingsView
        settings={data.page.settings.network}
        plugins={data.page.plugins}
        services={{
          ...capture,
          useSecretState: useSettingsSecretState,
          setDefaultProxy: method("network_setDefaultProxy"),
          setFeatureProxy: method("network_setFeatureProxy"),
          removeProfile: method("network_removeProfile"),
          saveProfile: (edit) =>
            adapter.call("network_saveProfile", {
              profile: edit.profile,
              credential: { action: edit.credential.action },
            }),
          renderConnectionTest: (settings) => (
            <NetworkConnectionTestView
              settings={settings}
              services={{ ...capture, test: method("network_test") }}
            />
          ),
        }}
      />
    );
  }
  function Storage() {
    return (
      <StorageSettingsView
        services={{
          ...capture,
          useData: () => useData().storage,
          load: method("storage_load"),
          changeDraft: (change) => effect("storage_changeDraft", change),
          schedule: method("storage_schedule"),
          cancel: method("storage_cancel"),
          pick: method("storage_pick"),
          open: method("storage_open"),
          reviewRestart: () => effect("storageRestart"),
          notify,
        }}
      />
    );
  }
  function Shortcuts() {
    return (
      <KeyboardShortcutsView
        services={{
          ...capture,
          useData: () => useData().shortcuts,
          setQuery: (query) => effect("shortcuts_setQuery", query),
          toggleFilter: (key, value) => effect("shortcuts_toggleFilter", key, value),
          change: method("shortcuts_change"),
          confirm,
        }}
      />
    );
  }
  function Special({ section, expanded }: { section: SettingsSpecialSection; expanded?: boolean }) {
    const data = useData();
    switch (section) {
      case "plugins":
        return <Plugins />;
      case "about":
        return (
          <AboutPageView
            embedded
            info={data.info}
            useViewState={useSettingsControlState}
            openLink={(link) => effect("aboutLink", link)}
          />
        );
      case "updates":
        return <Updates />;
      case "uiProviders":
        return (
          <UiProviderSettingsView
            {...data.providers}
            expanded={expanded}
            {...capture}
            choose={method("provider")}
          />
        );
      case "mountHostDetails":
        return (
          <MountHostDetailsSettingsView
            {...data.mountContributor}
            useBusyGuard={useSettingsBusyGuard}
            choose={(value) => effect("mountContributor", value)}
          />
        );
      case "network":
        return <Network />;
      case "storage":
        return <Storage />;
      case "shortcuts":
        return <Shortcuts />;
      case "logs":
        return <LogSettingsView onShowOutput={() => effect("showOutput")} />;
    }
  }
  function Configuration(props: { query: string; hidden: boolean; visible: boolean }) {
    return (
      <PluginConfigurationSectionView
        {...props}
        plugins={useData().plugins.filter((p) => p.configuration)}
        services={configuration}
      />
    );
  }
  const surface: PreferenceSurfaceServices = {
    useData: () => {
      const data = useData();
      return { settings: data.page.settings, busy: data.page.saving, error: data.page.error };
    },
    isCurrent: (settings) => adapter.current().page.settings === settings,
    Provider,
  };
  return {
    useData: () => useData().page,
    useViewState: useSettingsControlState,
    update: method("preference"),
    reset: method("reset"),
    confirm,
    selectSection: (section) => effect("section", section),
    renderProfiles: (props) => <Profiles {...props} />,
    renderSpecial: (section, options) => <Special section={section} expanded={options?.expanded} />,
    renderConfiguration: (props) => <Configuration {...props} />,
    renderPreferenceSurface: (props) => <PreferenceSurfaceView {...props} services={surface} />,
    renderProtectedRow: (props) => <Row {...props} />,
    fields: {
      renderTerminalPreview: () => <Preview />,
      renderUpdateSource: (props) => <UpdateSource {...props} />,
      renderHostList: () => <HostList />,
      renderCss: (props) => <Css {...props} />,
      renderRow: (props) => <Row {...props} />,
    },
  };
}
/** Complete shared production page. Presentation provider is supplied by the
 * owning document; a native entry must not replace a selected plugin silently. */
export function SettingsWindowContent({
  client,
  record,
  model,
  Provider,
  visible = true,
}: Pick<NativeViewProps, "client" | "record"> & {
  model: SettingsProjection;
  Provider: PreferenceSurfaceServices["Provider"];
  visible?: boolean;
}) {
  const drafts = useSettingsControlRegistry();
  const password = useSettingsPrivatePassword();
  const [adapter] = useState(() =>
    createSettingsWindowAdapter(client, record, drafts, model, password),
  );
  const [services] = useState(() => composition(adapter, Provider));
  useLayoutEffect(() => adapter.publish(model), [adapter, model]);
  return (
    <Context.Provider value={model}>
      <SettingsPageView visible={visible} services={services} />
    </Context.Provider>
  );
}
