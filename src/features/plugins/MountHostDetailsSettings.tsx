import { MountHostDetailsSettingsView } from "./components/MountHostDetailsSettingsView";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { useRef, useState } from "react";
import { hostDetailsContributors } from "@/lib/extensions/hostDetails";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

export function useMainMountHostDetailsSettings() {
  const plugins = usePlugins((state) => state.items);
  const selection = useSettings((state) => state.settings.mountHostDetailsSelection);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const contributors = hostDetailsContributors(plugins).filter(
    ({ contribution }) => contribution.kind === "mounts",
  );
  const value = selection ? JSON.stringify([selection.pluginId, selection.contributionId]) : "";
  const candidates = contributors.map(({ plugin, contribution }) => ({
    value: JSON.stringify([plugin.id, contribution.id]),
    label: `${plugin.name} · ${contribution.title}`,
  }));
  const choose = async (next: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const before = JSON.stringify(useSettings.getState().settings.mountHostDetailsSelection);
    await (async () => {
      try {
        const candidate = contributors.find(
          ({ plugin, contribution }) => JSON.stringify([plugin.id, contribution.id]) === next,
        );
        if (next && !candidate) throw new Error("plugin.frontend.viewUnavailable");
        if (candidate) {
          if (candidate.plugin.status !== "running")
            await usePlugins.getState().start(candidate.plugin.id);
          const current = usePlugins
            .getState()
            .items.find((item) => item.id === candidate.plugin.id);
          if (!current || current.status !== "running") return;
          if (current.fingerprint !== candidate.plugin.fingerprint)
            throw new Error("pluginSecurity.changed");
          const view = current.views.find((item) => item.id === candidate.contribution.viewId);
          if (view?.kind === "component") {
            await frontendRuntime.ensure(current);
            if (!frontendRuntime.view(current.id, view.id))
              throw new Error("plugin.frontend.viewUnavailable");
          } else if (view?.kind !== "sharedMounts") {
            throw new Error("plugin.frontend.viewUnavailable");
          }
          const latest = usePlugins.getState().items.find((item) => item.id === current.id);
          if (
            latest?.status !== "running" ||
            latest.fingerprint !== current.fingerprint ||
            latest.runtimeId !== current.runtimeId
          )
            throw new Error("pluginSecurity.changed");
        }
        if (JSON.stringify(useSettings.getState().settings.mountHostDetailsSelection) !== before)
          return;
        await useSettings.getState().update({
          mountHostDetailsSelection: candidate
            ? { pluginId: candidate.plugin.id, contributionId: candidate.contribution.id }
            : null,
        });
      } catch (error) {
        toast(translateError(error), "error");
      } finally {
        lock.current = false;
        setBusy(false);
      }
    })();
  };
  return { value, candidates, unavailableName: selection?.pluginId ?? "", busy, choose };
}
export function MountHostDetailsSettings() {
  const binding = useMainMountHostDetailsSettings();
  return <MountHostDetailsSettingsView {...binding} useBusyGuard={useBackgroundGuard} />;
}
