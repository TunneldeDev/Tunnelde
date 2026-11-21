import { invoke } from "@tauri-apps/api/core";
import type { ConnectionReview } from "@/lib/api/connections/review";
import type { SshConnectRequest, SshSession } from "@/lib/api/types";
import type { ForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import { copyText } from "@/lib/session/clipboard";
import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
import { forwardingGroupsStore } from "../data/groups";
import { forwardingStore } from "../data/store";
import type { ForwardGroup, ForwardRule, RevisionedRule } from "../model/contract";
import { forwardingSavePayload } from "../model/payload";

/** Document-local service boundary, not a serialized command or plugin API.
 * Native adapters must supply a complete exact-lease implementation. A provider
 * continuation remains authority, never a flag to retry as the built-in host. */
export interface ForwardingActions {
  refresh(): void;
  start(
    rule: RevisionedRule,
    authority?: ForwardingAuthority,
    request?: SshConnectRequest,
    review?: ConnectionReview,
  ): Promise<SshSession>;
  save(
    rule: ForwardRule,
    revision?: string,
    authority?: ForwardingAuthority,
    interaction?: string,
  ): Promise<RevisionedRule>;
  remove(
    rule: RevisionedRule,
    authority?: ForwardingAuthority,
    interaction?: string,
  ): Promise<void>;
  stop(
    rule: Pick<RevisionedRule, "id" | "revision"> & { runtimeId?: string | null },
    authority?: ForwardingAuthority,
  ): Promise<void>;
  disconnect(
    hostId: string,
    sessionId: string,
    authority?: ForwardingAuthority,
    interaction?: string,
  ): Promise<void>;
  saveGroup(hostId: string, name: string, group?: ForwardGroup): Promise<ForwardGroup>;
  removeGroup(group: ForwardGroup): Promise<void>;
  copyAddress(text: string): Promise<void>;
}

function mainDocument() {
  if (usePanelWindows.getState().windowId !== "main")
    throw new Error("panel.window.coordinatorRequired");
}
async function authorizedArgs(authority?: ForwardingAuthority) {
  mainDocument();
  if (!authority) return {};
  const origin = await authority.origin();
  mainDocument();
  authority.authorize();
  return { origin };
}

/** Main document only. The UI never imports raw IPC or mutates committed rule /
 * session sources. Native effect fencing is a separate admission requirement. */
export const localForwardingActions: ForwardingActions = Object.freeze<ForwardingActions>({
  refresh() {
    mainDocument();
    forwardingStore.refresh();
    forwardingGroupsStore.refresh();
  },
  async start(rule, authority, request, review) {
    const target = {
      id: rule.id,
      expectedRevision: rule.revision,
      ...(request ? { request: structuredClone(request), review: review && { ...review } } : {}),
    };
    const args = await authorizedArgs(authority);
    const connected = await invoke<SshSession>("forwarding_start_managed", { ...target, ...args });
    useSsh.getState().acceptSession(connected);
    return connected;
  },
  async save(rule, revision, authority) {
    if (rule.id && !revision) throw new Error("forward.changed");
    // Bind editable values before a provider scope acquisition can yield. The
    // caller's later edits cannot retarget a previously confirmed operation.
    const target = {
      rule: forwardingSavePayload(rule),
      groupId: rule.groupId ?? null,
      assignGroup: true,
      ...(rule.automation
        ? {
            automation: {
              autoStart: rule.automation.autoStart,
              autoRetry: rule.automation.autoRetry,
            },
          }
        : {}),
      ...(rule.id ? { expectedRevision: revision } : {}),
    };
    const args = await authorizedArgs(authority);
    const saved = await invoke<RevisionedRule>("forwarding_save", { ...target, ...args });
    forwardingStore.saved(saved);
    return saved;
  },
  async remove(rule, authority) {
    const target = { id: rule.id, expectedRevision: rule.revision };
    const args = await authorizedArgs(authority);
    await invoke("forwarding_remove", { ...target, ...args });
  },
  async stop(rule, authority) {
    if (!rule.revision || (authority && !rule.runtimeId)) throw new Error("forward.changed");
    const target = {
      id: rule.id,
      expectedRevision: rule.revision,
      runtimeId: rule.runtimeId ?? null,
    };
    const args = await authorizedArgs(authority);
    await invoke("forwarding_stop", { ...target, ...args });
  },
  async disconnect(hostId, sessionId, authority) {
    const args = await authorizedArgs(authority);
    const current = useSsh.getState().sessions.find((item) => item.id === sessionId);
    if (!current) return;
    if (current.hostId !== hostId || current.purpose !== "forwarding")
      throw new Error("ssh.sessionMissing");
    if (authority) {
      await invoke("forwarding_provider_disconnect", { sessionId, ...args });
      useSsh.getState().forget(sessionId);
    } else {
      let failed = false,
        cause: unknown;
      await useSsh.getState().disconnect(sessionId, (error) => {
        failed = true;
        cause = error;
      });
      if (failed) throw cause;
    }
  },
  async saveGroup(hostId, name, group) {
    mainDocument();
    if (group && group.hostId !== hostId) throw new Error("forward.changed");
    return invoke<ForwardGroup>("forwarding_group_save", {
      hostId,
      name,
      ...(group ? { id: group.id, expectedRevision: group.revision } : {}),
    });
  },
  async removeGroup(group) {
    mainDocument();
    await invoke("forwarding_group_remove", { id: group.id, expectedRevision: group.revision });
  },
  async copyAddress(text) {
    mainDocument();
    await copyText(text);
  },
});
