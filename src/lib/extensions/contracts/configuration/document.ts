import type { ConfigurationSchema } from "./schema.js";

export interface ConfigurationDocument {
  revision: string;
  schemaVersion: number;
  schemaDigest: string;
  values: Record<string, unknown>;
}
export interface ConfigurationSnapshot {
  schema: ConfigurationSchema;
  schemaDigest: string;
  /** "initial" before the first explicit save, UUID thereafter. Never a value hash. */
  revision: string;
  storedVersion: number | null;
  storedDigest: string | null;
  status: "ready" | "migrationRequired" | "incompatible";
  values: Record<string, unknown>;
}
export interface ConfigurationExpected {
  expectedRevision: string;
  schemaDigest: string;
}
export interface ConfigurationUpdate extends ConfigurationExpected {
  /** Complete replacement of every declared field; not a patch. */
  values: Record<string, unknown>;
}
export interface ConfigurationBackup {
  id: string;
  createdAt: string;
  reason: string;
  document: ConfigurationDocument;
}
export interface ConfigurationBackupRequest extends ConfigurationExpected {
  backupId: string;
}
