/** Pure data only. Digests are obtained from configuration.snapshot, not package hashes. */
export interface ConfigurationMigration {
  fromVersion: number;
  fromDigest: string;
  toVersion: number;
  toDigest: string;
  operations: (
    | { op: "rename"; from: string; to: string }
    | { op: "setDefault"; key: string; value: unknown }
    | { op: "remove"; key: string }
  )[];
}
