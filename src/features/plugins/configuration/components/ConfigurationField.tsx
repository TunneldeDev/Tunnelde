import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Field, Input, Switch, Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import type { ConfigurationField as FieldContract } from "@/lib/extensions/contracts/configuration/schema";
import { parseDraft } from "../data/values";

export function ConfigurationField({
  field,
  draft,
  disabled,
  onChange,
}: {
  field: FieldContract;
  draft: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const { t } = useTranslation();
  const { schema } = field;
  const valid = parseDraft(field, draft).valid;
  return (
    <Field
      label={field.title}
      htmlFor={schema.type === "boolean" ? undefined : id}
      hint={field.description}
      error={!valid ? t("configuration.invalidValue", { field: field.id }) : null}
    >
      <code className="plugin-configuration__field-id">{field.id}</code>
      {schema.type === "boolean" ? (
        <Switch
          label={field.title}
          checked={draft === "true"}
          disabled={disabled}
          onChange={(value) => onChange(String(value))}
        />
      ) : schema.type === "string" && schema.enum ? (
        <Select
          id={id}
          label={field.title}
          value={draft}
          disabled={disabled}
          onChange={onChange}
          options={schema.enum.map((value) => ({
            value,
            label: value || t("configuration.emptyValue"),
          }))}
        />
      ) : schema.type === "array" || schema.type === "object" ? (
        <Textarea
          id={id}
          rows={5}
          value={draft}
          disabled={disabled}
          aria-invalid={!valid}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          type={schema.type === "string" ? "text" : "number"}
          value={draft}
          disabled={disabled}
          aria-invalid={!valid}
          min={schema.type !== "string" ? schema.minimum : undefined}
          max={schema.type !== "string" ? schema.maximum : undefined}
          step={schema.type === "integer" ? 1 : "any"}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
