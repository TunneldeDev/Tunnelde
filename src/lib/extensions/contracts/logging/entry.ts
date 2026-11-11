export type PluginLogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type PluginLogJson =
  | null
  | boolean
  | number
  | string
  | readonly PluginLogJson[]
  | { readonly [key: string]: PluginLogJson };

export interface PluginLogEntry {
  readonly timestamp: string | null;
  readonly level: PluginLogLevel;
  readonly domain: string;
  readonly pluginId: string | null;
  readonly message: string;
  readonly fields: { readonly [key: string]: PluginLogJson };
  readonly truncated: boolean;
}
