/** Transient native metadata. Never proof of ownership, write settlement or cleanup. */
import type { RecoveryCapabilityObservation } from "./capabilities";

export type RecoveryArtifactName =
  | "pid"
  | "heartbeat"
  | "STOP"
  | "status.json"
  | "events.jsonl"
  | "events.previous.jsonl"
  | "approvals.json"
  | "storage.json"
  | "inbox";

export type RecoveryArtifactSnapshot =
  | { status: "missing" }
  | {
      status: "present";
      entries: {
        name: RecoveryArtifactName;
        kind: "file" | "directory" | "link" | "other";
        /** Canonical u64 decimal text; null for non-files. */
        sizeBytes: string | null;
      }[];
      otherEntries: number;
    }
  | {
      status: "unavailable";
      reason:
        | "admissionUnavailable"
        | "unsafeDirectory"
        | "namespaceChanged"
        | "enumerationLimit"
        | "metadataUnavailable";
    };

export interface RecoveryArtifactObservation {
  token: string;
  checkedAt: number;
  result:
    | {
        status: "observed";
        admission: "reserved" | "launched" | "cancelled" | null;
        consistency: "pointInTime";
        cleanupAuthorized: false;
        snapshot: RecoveryArtifactSnapshot;
      }
    | { status: "unsupported"; reason: "legacyTask" | "helperCapability" }
    | Extract<RecoveryCapabilityObservation["result"], { status: "unavailable" }>;
}
