import {
  UiProviderSettingsView,
  UI_PROVIDER_SETTINGS_TARGETS,
} from "./components/UiProviderSettingsView";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { useRef, useState } from "react";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { api, isTauri } from "@/lib/api/ipc";
import { workspaceRecords } from "@/store/workspace";
import { uiProviders } from "@/lib/extensions/providers";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { FrontendProviderTarget } from "@/lib/extensions/contracts/frontend/providers";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

export function UiProviderSettings({ expanded = false }: { expanded?: boolean }) {
  const plugins = usePlugins((state) => state.items);
  const selections = useSettings((state) => state.settings.uiProviders);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const choose = async (target: FrontendProviderTarget, value: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const before = JSON.stringify(useSettings.getState().settings.uiProviders?.[target]);
    try {
      const candidate = uiProviders(plugins, target).find(
        ({ plugin, view }) => JSON.stringify([plugin.id, view.id]) === value,
      );
      if (value && !candidate) throw new Error("plugin.frontend.viewUnavailable");
      if (candidate) {
        if (candidate.plugin.status !== "running")
          await usePlugins.getState().start(candidate.plugin.id);
        const current = usePlugins.getState().items.find((item) => item.id === candidate.plugin.id);
        if (!current || current.status !== "running") return;
        if (current.fingerprint !== candidate.plugin.fingerprint)
          throw new Error("pluginSecurity.changed");
        await frontendRuntime.ensure(current);
        if (!frontendRuntime.view(current.id, candidate.view.id))
          throw new Error("plugin.frontend.viewUnavailable");
      }
      // Persist the host's live layout before switching its presentation. Contents and
      // pane identities are never replaced or hydrated from a stale snapshot on restore.
      if (target === "workbench" && isTauri()) await api.saveTabs(workspaceRecords());
      if (JSON.stringify(useSettings.getState().settings.uiProviders?.[target]) !== before) return;
      if (candidate) {
        const latest = usePlugins.getState().items.find((item) => item.id === candidate.plugin.id);
        if (
          !latest ||
          latest.status !== "running" ||
          latest.fingerprint !== candidate.plugin.fingerprint
        )
          throw new Error("pluginSecurity.changed");
      }
      const next = { ...useSettings.getState().settings.uiProviders };
      if (candidate) next[target] = { pluginId: candidate.plugin.id, viewId: candidate.view.id };
      else delete next[target];
      await useSettings.getState().update({ uiProviders: next });
    } catch (error) {
      toast(translateError(error), "error");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const rows = UI_PROVIDER_SETTINGS_TARGETS.map((target) => ({
    target,
    selected: selections?.[target] ?? null,
    candidates: uiProviders(plugins, target).map(({ plugin, view }) => ({
      value: JSON.stringify([plugin.id, view.id]),
      label: `${plugin.name} · ${view.title}`,
    })),
  }));
  return (
    <UiProviderSettingsView
      rows={rows}
      busy={busy}
      expanded={expanded}
      choose={choose}
      useViewState={useViewState}
      useBusyGuard={useBackgroundGuard}
    />
  );
}
