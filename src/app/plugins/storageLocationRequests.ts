import i18n from "@/i18n/i18n";
import { displayStoragePath } from "@/lib/api/storage";
import type { HostStorageSnapshot, HostStoragePlanChange } from "@/lib/extensions/uiSdkContract";

/** The backend supplies the normalized plan, never plugin-authored dialog text. */
export function storageLocationReview(method: string, params: Record<string, unknown>): string {
  const snapshot = params.snapshot as HostStorageSnapshot;
  const changes = (
    method === "storage.locations.cancel" ? snapshot?.pending?.changes : params.changes
  ) as readonly HostStoragePlanChange[] | undefined;
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.locations) ||
    snapshot.locations.length !== 8 ||
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > 8
  )
    throw new Error("storage.locations.invalidState");
  const categories = {
    database: "storage.categories.database",
    plugins: "storage.categories.plugins",
    pluginData: "storage.categories.pluginData",
    keys: "storage.categories.keys",
    runtimes: "storage.categories.runtimes",
    cache: "storage.categories.cache",
    logs: "storage.categories.logs",
    runners: "storage.categories.runners",
  } as const;
  const lines = changes.map((change: HostStoragePlanChange) => {
    const location = snapshot.locations.find((item) => item.category === change.category);
    if (
      !location ||
      !Object.hasOwn(categories, change.category) ||
      typeof location.path !== "string" ||
      typeof change.target !== "string" ||
      typeof change.migrate !== "boolean"
    )
      throw new Error("storage.locations.invalidState");
    return `${i18n.t(categories[change.category])}\n${displayStoragePath(location.path)}\n→ ${displayStoragePath(change.target)}\n${i18n.t(change.migrate ? "storage.locations.withData" : "storage.locations.withoutData")}`;
  });
  return `${i18n.t(method === "storage.locations.cancel" ? "storage.locations.reviewCancel" : "storage.locations.reviewSchedule")}\n\n${lines.join("\n\n")}`;
}
