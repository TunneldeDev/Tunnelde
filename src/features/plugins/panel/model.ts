import type { MarketEntry, MarketSource, PluginInfo } from "@/lib/api/types";
export type DisplayPlugin = Pick<
  PluginInfo,
  | "id"
  | "name"
  | "version"
  | "description"
  | "author"
  | "tags"
  | "apiVersion"
  | "sourceId"
  | "sourceUrl"
  | "path"
> & { runtime?: MarketEntry["runtime"] };
export type DisplayEntry = Pick<
  MarketEntry,
  "id" | "name" | "version" | "description" | "author" | "tags" | "runtime" | "apiVersion"
>;
export interface PluginListTarget {
  id: string;
  revision: string;
}
export type PluginListCommand =
  | { operation: "refresh" | "localInstall" | "settings" | "openDirectory" }
  | { operation: "open" | "keep" | "install"; target: PluginListTarget };
export interface PluginBrowserData {
  config: { sources: MarketSource[] };
  catalogues: Record<string, { entries: DisplayEntry[]; stale: boolean; checkedAt: number }>;
  errors: Record<string, string>;
  loading: string[];
  ready: boolean;
  configError: string | null;
  configLoading: boolean;
  items: DisplayPlugin[];
  busyIds: string[];
  tasks: Record<string, boolean>;
  active: string | null;
  targets: Record<string, PluginListTarget>;
}
export interface PluginBrowserState {
  query: string;
  tag: string;
  page: number;
  scope: "market" | "installed" | "updates";
}
export function validBrowserState(value: unknown): value is PluginBrowserState {
  if (!value || typeof value !== "object") return false;
  const s = value as PluginBrowserState;
  return (
    typeof s.query === "string" &&
    s.query.length <= 16384 &&
    typeof s.tag === "string" &&
    s.tag.length <= 1024 &&
    Number.isSafeInteger(s.page) &&
    s.page >= 0 &&
    ["market", "installed", "updates"].includes(s.scope)
  );
}
export const pluginListKey = (origin: string, id: string) => JSON.stringify([origin, id]);
