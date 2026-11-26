import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";
import { NumberPreference } from "../NumberPreference";
import { useLocalControlState, type SettingsControlState } from "./controlState";

export interface NumericUnit {
  label: string;
  factor: number;
}

/** Values stay in the API's base unit; choice and unit drafts belong to this surface. */
export function NumericChoice({
  value,
  min,
  max,
  options,
  units,
  label,
  descriptionId,
  disabled,
  onChange,
  useViewState = useLocalControlState,
  stateKey,
}: {
  value: number;
  min: number;
  max: number;
  options?: { value: string; label: string }[];
  units?: NumericUnit[];
  label: string;
  descriptionId?: string;
  disabled?: boolean;
  onChange(value: number): void;
  useViewState?: SettingsControlState;
  stateKey: string;
}) {
  const { t } = useTranslation();
  const [custom, setCustom] = useViewState(`${stateKey}:custom`, false);
  const [factor, setFactor] = useViewState(`${stateKey}:unit`, units?.[0]?.factor ?? 1);
  const unit = units?.find((unit) => unit.factor === factor) ?? { factor: 1, label: "" };
  const known = options?.some((option) => Number(option.value) === value);
  const showInput = !options || custom || !known;
  return (
    <div className="settings-numeric-choice">
      {options ? (
        <Select
          label={label}
          descriptionId={descriptionId}
          value={showInput ? "custom" : String(value)}
          disabled={disabled}
          options={[...options, { value: "custom", label: t("settings.customValue") }]}
          onChange={(next) => {
            setCustom(next === "custom");
            if (next !== "custom") onChange(Number(next));
          }}
        />
      ) : null}
      {showInput ? (
        <>
          <NumberPreference
            key={unit.factor}
            stateKey={`${stateKey}:value:${unit.factor}`}
            useViewState={useViewState}
            label={options ? t("settings.customValueFor", { name: label }) : label}
            descriptionId={descriptionId}
            value={value / unit.factor}
            min={min / unit.factor}
            max={max / unit.factor}
            step={1 / unit.factor}
            integerScale={unit.factor}
            disabled={disabled}
            onChange={(next) => onChange(Math.round(next * unit.factor))}
          />
          {units ? (
            <Select
              label={t("settings.unitFor", { name: label })}
              value={String(unit.factor)}
              disabled={disabled}
              options={units.map((unit) => ({ value: String(unit.factor), label: unit.label }))}
              onChange={(next) => setFactor(Number(next))}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
