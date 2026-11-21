import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
export function MountHostDetailsSettingsView({
  value,
  candidates,
  unavailableName,
  busy,
  choose,
  useBusyGuard,
}: {
  value: string;
  candidates: { value: string; label: string }[];
  unavailableName: string;
  busy: boolean;
  choose(value: string): void;
  useBusyGuard(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  useBusyGuard(busy);
  const options = [...candidates];
  if (value && !options.some((option) => option.value === value))
    options.push({ value, label: `${unavailableName} (${t("providers.unavailable")})` });
  return (
    <Field htmlFor={id} label={t("providers.hostMounts")}>
      <Select
        id={id}
        label={t("providers.hostMounts")}
        value={value}
        options={[{ value: "", label: t("providers.disabled") }, ...options]}
        disabled={busy}
        onChange={choose}
      />
    </Field>
  );
}
