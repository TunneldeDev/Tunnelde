// BEGIN GENERATED HOST FIELDS V1 TYPES
/** Experimental public metadata, independent of Host and internal settings. */
export interface HostField {
  id: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  options?: { value: string; label: string }[];
}
export interface HostFieldsSchema {
  version: number;
  fields: HostField[];
}
export type HostFieldValue = string | number | boolean;
export interface HostFieldsDocument {
  hostId: string;
  revision: number;
  schemaDigest: string;
  schemaVersion: number;
  storedSchemaVersion: number | null;
  schemaChanged: boolean;
  values: Record<string, HostFieldValue>;
}
export interface HostFieldsSnapshot {
  schema: HostFieldsSchema;
  document: HostFieldsDocument;
}
export interface HostFieldsUpdate {
  hostId: string;
  expectedRevision: number;
  schemaDigest: string;
  values: Record<string, HostFieldValue>;
}
// END GENERATED HOST FIELDS V1 TYPES

export function validHostField(field: HostField, value: unknown): value is HostFieldValue {
  switch (field.type) {
    case "text":
      return (
        typeof value === "string" &&
        [...value].length <= (field.maxLength ?? 4096) &&
        !value.includes("\0")
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.minimum == null || value >= field.minimum) &&
        (field.maximum == null || value <= field.maximum)
      );
    case "boolean":
      return typeof value === "boolean";
    case "select":
      return typeof value === "string" && !!field.options?.some((option) => option.value === value);
  }
}

/** Explicit reconciliation retains only values valid under the current schema. */
export function reconcileHostFields(snapshot: HostFieldsSnapshot): Record<string, HostFieldValue> {
  return Object.fromEntries(
    snapshot.schema.fields.flatMap((field) => {
      const value = snapshot.document.values[field.id];
      return validHostField(field, value) ? [[field.id, value]] : [];
    }),
  );
}
