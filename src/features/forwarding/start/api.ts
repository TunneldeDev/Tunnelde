import { invoke } from "@tauri-apps/api/core";
import type { Host, HostKeyInfo, SshConnectRequest, SshSession } from "@/lib/api/types";
import type { ForwardRule } from "../model/contract";

export interface PendingForwardStart {
  receipt: {
    id: string;
    revision: string;
    requestId: string;
    phase: "credentials" | "connecting" | "preparing";
    expiresAt: number;
  };
  host: Host;
  jumpHosts: Host[];
  rule: ForwardRule;
}
type Credentials = NonNullable<SshConnectRequest["jumpCredentials"]>;
export const forwardStartPending = (uiId: string) =>
  invoke<PendingForwardStart | null>("forwarding_start_pending", { uiId });
export const forwardStartRelease = (uiId: string) =>
  invoke<void>("forwarding_start_release_ui", { uiId });
export const forwardStartCancel = (requestId: string) =>
  invoke("forwarding_start_cancel", { requestId });
export function forwardStartConnection(pending: PendingForwardStart, uiId: string) {
  const scope = { requestId: pending.receipt.requestId, uiId };
  return {
    verification: {
      jumpHosts: pending.jumpHosts,
      probe: (credentials: Credentials = {}) =>
        invoke<HostKeyInfo>("forwarding_start_probe", { ...scope, credentials }),
      trust: (
        fingerprint: string,
        credentials: Credentials = {},
        expectedHostId = pending.host.id,
      ) =>
        invoke<HostKeyInfo>("forwarding_start_trust", {
          ...scope,
          fingerprint,
          credentials,
          expectedHostId,
        }),
    },
    connect: (request: SshConnectRequest) =>
      invoke<SshSession>("forwarding_start_connect", { ...scope, request }),
  };
}
