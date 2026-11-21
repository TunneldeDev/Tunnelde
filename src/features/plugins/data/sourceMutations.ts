import type { MarketSource } from "@/lib/api/types";
export type SourceChange =
  | { kind: "toggle"; id: string; enabled: boolean }
  | { kind: "remove"; expected: MarketSource }
  | { kind: "save"; source: MarketSource; expected: MarketSource | null };
const sameSource = (a: MarketSource, b: MarketSource) =>
  a.id === b.id && a.url === b.url && a.name === b.name && a.enabled === b.enabled;
/** Execute after trust/destructive confirmation, against the current owner list. */
export function changePluginSources(current: MarketSource[], change: SourceChange): MarketSource[] {
  if (change.kind === "toggle") {
    if (!current.some((source) => source.id === change.id)) throw new Error("market.sourceChanged");
    return current.map((source) =>
      source.id === change.id ? { ...source, enabled: change.enabled } : source,
    );
  }
  const id = change.kind === "save" ? change.source.id : change.expected.id;
  const existing = current.find((source) => source.id === id);
  if (id === "official") throw new Error("market.sourceChanged");
  if (change.expected ? !existing || !sameSource(existing, change.expected) : !!existing)
    throw new Error("market.sourceChanged");
  if (change.kind === "remove") return current.filter((source) => source.id !== id);
  if (current.some((source) => source.id !== id && source.url === change.source.url))
    throw new Error("market.duplicateSource");
  return existing
    ? current.map((source) => (source.id === id ? change.source : source))
    : [...current, change.source];
}
