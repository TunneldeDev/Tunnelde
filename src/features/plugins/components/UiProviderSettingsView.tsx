import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Disclosure } from "@/components/ui/layout/Disclosure";
import { Select } from "@/components/ui/form/Select";
import type { FrontendProviderTarget } from "@/lib/extensions/contracts/frontend/providers";
import type { SettingsControlState } from "@/features/settings/components/controlState";
export const UI_PROVIDER_SETTINGS_TARGETS = [
  "hostList",
  "workbench",
  "fileBrowser",
  "filePreview",
  "terminal",
  "history",
  "forwarding",
  "monitor",
  "backgroundTasks",
  "processes",
  "quickAccess",
  "preferences",
] as const;

export interface ProviderSettingsRow {
  target: (typeof UI_PROVIDER_SETTINGS_TARGETS)[number];
  selected: { pluginId: string; viewId: string } | null;
  candidates: { value: string; label: string }[];
}
export function UiProviderSettingsView({
  rows,
  busy,
  expanded = false,
  choose,
  useViewState,
  useBusyGuard,
}: {
  rows: ProviderSettingsRow[];
  busy: boolean;
  expanded?: boolean;
  choose(target: FrontendProviderTarget, value: string): Promise<void>;
  useViewState: SettingsControlState;
  useBusyGuard(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [opened, setOpened] = useViewState("settings:providers:open", false);
  useBusyGuard(busy);
  const customCount = rows.filter((row) => row.selected).length;
  const unavailableCount = rows.filter(
    (row) =>
      row.selected &&
      !row.candidates.some(
        (option) => option.value === JSON.stringify([row.selected!.pluginId, row.selected!.viewId]),
      ),
  ).length;
  return (
    <section className="settings-subsection ui-provider-settings" aria-label={t("providers.title")}>
      <Disclosure
        heading={t("providers.title")}
        summary={[
          customCount
            ? t("providers.customCount", { count: customCount })
            : t("providers.allBuiltin"),
          unavailableCount ? t("providers.unavailableCount", { count: unavailableCount }) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
        open={expanded || opened}
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <p className="settings-hint">{t("providers.hint")}</p>
        <div className="ui-provider-settings__rows">
          {rows.map(({ target, selected, candidates }) => {
            const value = selected ? JSON.stringify([selected.pluginId, selected.viewId]) : "";
            const options = [...candidates];
            if (selected && !options.some((option) => option.value === value))
              options.push({
                value,
                label: `${selected.pluginId} · ${selected.viewId} (${t("providers.unavailable")})`,
              });
            return (
              <div key={target} className="ui-provider-settings__row">
                <label htmlFor={`${id}-${target}`}>{t(`providers.${target}`)}</label>
                <Select
                  id={`${id}-${target}`}
                  value={value}
                  disabled={busy}
                  label={t(`providers.${target}`)}
                  options={[{ value: "", label: t("providers.builtin") }, ...options]}
                  onChange={(next) => void choose(target, next)}
                />
              </div>
            );
          })}
        </div>
      </Disclosure>
    </section>
  );
}
