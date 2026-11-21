import type { NetworkSettings } from "@/lib/api/network";
export type NetworkRouteChange =
  | { kind: "default"; value: string }
  | { kind: "feature"; feature: string; value: string }
  | { kind: "remove"; id: string };
/** Apply to the owner's current snapshot, never a stale rendered projection. */
export function changeNetworkRoute(
  current: NetworkSettings,
  change: NetworkRouteChange,
): NetworkSettings {
  switch (change.kind) {
    case "default":
      return { ...current, defaultProxy: change.value };
    case "feature":
      return { ...current, features: { ...current.features, [change.feature]: change.value } };
    case "remove":
      return {
        ...current,
        profiles: current.profiles.filter((profile) => profile.id !== change.id),
        features: Object.fromEntries(
          Object.entries(current.features).map(([key, value]) => [
            key,
            value === change.id ? "" : value,
          ]),
        ),
        defaultProxy: current.defaultProxy === change.id ? "system" : current.defaultProxy,
      };
  }
}
