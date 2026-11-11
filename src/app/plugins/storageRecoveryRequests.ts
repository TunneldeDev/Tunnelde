import i18n from "@/i18n/i18n";
import { displayStoragePath } from "@/lib/api/storage";
import type {
  HostStorageRecoverySnapshot,
  HostStoragePlanChange,
} from "@/lib/extensions/uiSdkContract";

/** Only native projected metadata enters this dialog, never plugin-authored prose. */
export function storageRecoveryReview(params: Record<string, unknown>): string {
  const snapshot = params.snapshot as HostStorageRecoverySnapshot;
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !snapshot.pending ||
    !["retry", "cancel"].includes(String(params.action)) ||
    !["apply", "cancel"].includes(snapshot.pending.action) ||
    !Array.isArray(snapshot.locations) ||
    snapshot.locations.length !== 8 ||
    !Array.isArray(snapshot.pending.changes) ||
    !snapshot.pending.changes.length ||
    snapshot.pending.changes.length > 8
  )
    throw new Error("storage.recovery.invalidState");
  const cancel = params.action === "cancel" || snapshot.pending.action === "cancel";
  const lines = snapshot.pending.changes.map((change: HostStoragePlanChange) => {
    const location = snapshot.locations.find((item) => item.category === change.category);
    if (
      !location ||
      typeof location.path !== "string" ||
      typeof change.target !== "string" ||
      typeof change.migrate !== "boolean"
    )
      throw new Error("storage.recovery.invalidState");
    return `${i18n.t(`storage.categories.${change.category}`)}\n${displayStoragePath(location.path)}\n→ ${displayStoragePath(change.target)}\n${i18n.t(change.migrate ? "storage.locations.withData" : "storage.locations.withoutData")}`;
  });
  return `${i18n.t(cancel ? "storage.recovery.reviewCancel" : "storage.recovery.reviewRetry")}\n\n${lines.join("\n\n")}\n\n${i18n.t("storage.recovery.reviewBoundaries")}`;
}
