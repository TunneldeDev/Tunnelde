import type {
  ConfigurationField,
  ConfigurationValueSchema,
} from "@/lib/extensions/contracts/configuration/schema";

export function validValue(schema: ConfigurationValueSchema, value: unknown): boolean {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isInteger(value)) &&
        value >= schema.minimum &&
        value <= schema.maximum
      );
    case "string":
      return (
        typeof value === "string" &&
        !value.includes("\0") &&
        [...value].length <= schema.maxLength &&
        [...value].length >= (schema.minLength ?? 0) &&
        (!schema.enum || schema.enum.includes(value))
      );
    case "array":
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.every((item) => validValue(schema.items, item))
      );
    case "object":
      return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => Object.hasOwn(schema.properties, key)) &&
        schema.required.every((key) => Object.hasOwn(value, key)) &&
        Object.entries(value).every(([key, child]) => validValue(schema.properties[key]!, child))
      );
  }
}

export const fieldDraft = (field: ConfigurationField, value: unknown) =>
  field.schema.type === "string" ? String(value ?? "") : (JSON.stringify(value, null, 2) ?? "");

export function parseDraft(
  field: ConfigurationField,
  draft: string,
): { valid: boolean; value: unknown } {
  try {
    const value: unknown = field.schema.type === "string" ? draft : JSON.parse(draft);
    return { valid: validValue(field.schema, value), value };
  } catch {
    return { valid: false, value: undefined };
  }
}
