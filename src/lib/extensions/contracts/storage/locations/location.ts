export type HostStorageCategory =
  "database" | "plugins" | "pluginData" | "keys" | "runtimes" | "cache" | "logs" | "runners";

/** Absolute host paths; metadata permission never grants content access. */
export interface HostStorageLocation {
  readonly category: HostStorageCategory;
  readonly path: string;
  readonly defaultPath: string;
  /** True when the plugins directory is forced by the environment. */
  readonly overridden: boolean;
}
export interface HostStoragePlanChange {
  readonly category: HostStorageCategory;
  readonly target: string;
  readonly migrate: boolean;
}
