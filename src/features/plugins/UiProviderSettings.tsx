import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { api, isTauri } from "@/lib/api/ipc";
import { workspaceRecords } from "@/store/workspace";
import { uiProviders } from "@/lib/extensions/providers";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { FrontendProviderTarget } from "@/lib/extensions/uiSdkContract";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

export function UiProviderSettings() {
  const { t } = useTranslation();
  const id = useId();
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
  return (
    <section className="settings-subsection ui-provider-settings" aria-label={t("providers.title")}>
      <h3 className="settings-subtitle">{t("providers.title")}</h3>
      <p className="settings-hint">{t("providers.hint")}</p>
      {(["hostList", "workbench"] as const).map((target) => {
        const selected = selections?.[target];
        const value = selected ? JSON.stringify([selected.pluginId, selected.viewId]) : "";
        const options = uiProviders(plugins, target).map(({ plugin, view }) => ({
          value: JSON.stringify([plugin.id, view.id]),
          label: `${plugin.name} · ${view.title}`,
        }));
        if (selected && !options.some((option) => option.value === value))
          options.push({
            value,
            label: `${selected.pluginId} · ${selected.viewId} (${t("providers.unavailable")})`,
          });
        return (
          <Field key={target} htmlFor={`${id}-${target}`} label={t(`providers.${target}`)}>
            <Select
              id={`${id}-${target}`}
              value={value}
              disabled={busy}
              label={t(`providers.${target}`)}
              options={[{ value: "", label: t("providers.builtin") }, ...options]}
              onChange={(next) => void choose(target, next)}
            />
          </Field>
        );
      })}
    </section>
  );
}
