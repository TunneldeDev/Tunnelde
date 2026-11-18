import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { hostDetailsContributors } from "@/lib/extensions/hostDetails";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

export function MountHostDetailsSettings() {
  const { t } = useTranslation();
  const id = useId();
  const plugins = usePlugins((state) => state.items);
  const selection = useSettings((state) => state.settings.mountHostDetailsSelection);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const contributors = hostDetailsContributors(plugins).filter(
    ({ contribution }) => contribution.kind === "mounts",
  );
  const value = selection ? JSON.stringify([selection.pluginId, selection.contributionId]) : "";
  const options = contributors.map(({ plugin, contribution }) => ({
    value: JSON.stringify([plugin.id, contribution.id]),
    label: `${plugin.name} · ${contribution.title}`,
  }));
  if (selection && !options.some((option) => option.value === value))
    options.push({ value, label: `${selection.pluginId} (${t("providers.unavailable")})` });
  return (
    <Field htmlFor={id} label={t("providers.hostMounts")}>
      <Select
        id={id}
        label={t("providers.hostMounts")}
        value={value}
        options={[{ value: "", label: t("providers.disabled") }, ...options]}
        disabled={busy}
        onChange={(next) => {
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          const before = JSON.stringify(useSettings.getState().settings.mountHostDetailsSelection);
          void (async () => {
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
                await frontendRuntime.ensure(current);
                if (!frontendRuntime.view(current.id, candidate.contribution.viewId))
                  throw new Error("plugin.frontend.viewUnavailable");
                const latest = usePlugins.getState().items.find((item) => item.id === current.id);
                if (latest?.status !== "running" || latest.fingerprint !== current.fingerprint)
                  throw new Error("pluginSecurity.changed");
              }
              if (
                JSON.stringify(useSettings.getState().settings.mountHostDetailsSelection) !== before
              )
                return;
              await useSettings
                .getState()
                .update({
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
        }}
      />
    </Field>
  );
}
