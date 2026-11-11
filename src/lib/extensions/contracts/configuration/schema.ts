import type { ConfigurationMigration } from "./migration.js";

/** Experimental, closed JSON Schema subset. All sizes count Unicode code points. */
export type ConfigurationValueSchema =
  | { type: "string"; maxLength: number; minLength?: number; enum?: string[] }
  | { type: "boolean" }
  | { type: "number" | "integer"; minimum: number; maximum: number }
  | { type: "array"; items: ConfigurationValueSchema; maxItems: number }
  | {
      type: "object";
      properties: Record<string, ConfigurationValueSchema>;
      required: string[];
      additionalProperties: false;
    };

export interface ConfigurationField {
  id: string;
  group: string;
  title: string;
  description?: string;
  schema: ConfigurationValueSchema;
  default: unknown;
}
export interface ConfigurationSchema {
  version: number;
  groups: Array<{ id: string; title: string }>;
  fields: ConfigurationField[];
  migrations?: ConfigurationMigration[];
}
