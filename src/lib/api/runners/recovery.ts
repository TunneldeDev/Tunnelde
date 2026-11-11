import { invoke } from "@tauri-apps/api/core";
import type {
  RecoveryOwners,
  RecoverySnapshot,
  RecoveryRequest,
  RecoveryOutcome,
  RecoveryBrowserRequest,
  RecoveryBrowserPlan,
  RecoveryBrowserTarget,
} from "@/lib/runners/recovery/contracts";
import type { HostKeyInfo, SshConnectRequest, SshSession } from "@/lib/api/types";

export const runnerRecoveryApi = {
  owners: () => invoke<RecoveryOwners>("runner_recovery_owners"),
  snapshot: (pluginId: string, offset: number) =>
    invoke<RecoverySnapshot>("runner_recovery_snapshot", { pluginId, offset }),
  action: (request: RecoveryRequest) =>
    invoke<RecoveryOutcome>("runner_recovery_action", { request }),
  prepareBrowser: (request: RecoveryBrowserRequest) =>
    invoke<RecoveryBrowserPlan>("runner_recovery_browser_prepare", { request }),
  cancelBrowser: (id: string) => invoke<void>("runner_recovery_browser_cancel", { id }),
  probeBrowser: (id: string, jumpCredentials: SshConnectRequest["jumpCredentials"]) =>
    invoke<HostKeyInfo>("runner_recovery_browser_probe", { id, jumpCredentials }),
  trustBrowser: (
    id: string,
    fingerprint: string,
    jumpCredentials: SshConnectRequest["jumpCredentials"],
    expectedHostId?: string,
  ) =>
    invoke<HostKeyInfo>("runner_recovery_browser_trust", {
      id,
      fingerprint,
      jumpCredentials,
      expectedHostId,
    }),
  connectBrowser: (id: string, request: SshConnectRequest) =>
    invoke<SshSession>("runner_recovery_browser_connect", { id, request }),
  openBrowser: (id: string) =>
    invoke<RecoveryBrowserTarget>("runner_recovery_browser_open", { id }),
};
