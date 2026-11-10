import { invoke } from "@tauri-apps/api/core";
import type {
  RecoveryOwners,
  RecoverySnapshot,
  RecoveryRequest,
  RecoveryOutcome,
} from "@/lib/runners/recovery/contracts";

export const runnerRecoveryApi = {
  owners: () => invoke<RecoveryOwners>("runner_recovery_owners"),
  snapshot: (pluginId: string, offset: number) =>
    invoke<RecoverySnapshot>("runner_recovery_snapshot", { pluginId, offset }),
  action: (request: RecoveryRequest) =>
    invoke<RecoveryOutcome>("runner_recovery_action", { request }),
};
