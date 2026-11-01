import type {
  MarketCatalogue,
  MarketEntry,
  MarketSource,
  PluginConfig,
  PluginInfo,
  PluginTheme,
} from "@/lib/api/types";
import { MARKETPLACE_INDEX_URL } from "@/lib/plugins/marketplace";

export const official: MarketSource = {
  id: "official",
  name: "Tunnelde",
  url: MARKETPLACE_INDEX_URL,
  enabled: true,
};
export const community: MarketSource = {
  id: "community",
  name: "Community",
  url: "https://plugins.example.org/index.json",
  enabled: true,
};
export const entry: MarketEntry = {
  id: "formatter",
  name: "Formatter",
  version: "2.0.0",
  description: "Format local JSON",
  author: "Tools Publisher",
  runtime: "node",
  apiVersion: 1,
  url: "https://plugins.example.org/formatter.zip",
  sha256: "a".repeat(64),
};
export const plugin: PluginInfo = {
  id: "formatter",
  name: "Formatter",
  version: "1.0.0",
  description: "Format local JSON",
  author: null,
  runtime: "node",
  apiVersion: 1,
  commands: [{ id: "pretty", title: "Format JSON" }],
  views: [{ id: "main", title: "JSON tool" }],
  permissions: [],
  path: "plugins/formatter",
  fingerprint: "a".repeat(64),
  status: "stopped",
  error: null,
  sourceId: official.id,
  sourceUrl: official.url,
};
export const darkTheme: PluginTheme = {
  id: "cobalt-dusk",
  name: "Cobalt Dusk",
  appearance: "dark",
  accent: "#78aaff",
  colors: { background: "#101827", sidebar: "#131d2e", editor: "#172238" },
};
export const lightTheme: PluginTheme = {
  id: "porcelain",
  name: "Porcelain",
  appearance: "light",
  colors: { background: "#f8f7f3", editor: "#ffffff" },
};
export const themePack: PluginInfo = {
  ...plugin,
  id: "studio-themes",
  name: "Studio Themes",
  runtime: "theme",
  commands: [],
  views: [],
  themes: [darkTheme, lightTheme],
};
export const config = (sources: MarketSource[] = [official]): PluginConfig => ({
  sources,
  nodePath: null,
  nodeSystemAllowed: false,
});
export const catalogue = (source = official, entries = [entry]): MarketCatalogue => ({
  source,
  entries,
  checkedAt: 1000,
  stale: false,
  error: null,
});
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
