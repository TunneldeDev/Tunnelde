import type { ConnectionPromptHost } from "@/features/connect/prompt";
import type { SshSession } from "@/lib/api/types";
import type { ForwardGroup, ForwardInfo } from "../model/contract";

/** Explicit private display data, never writable host/session stores or a
 * provider capability. Errors cross documents only as rendered messages. */
export interface ForwardingReadSnapshot<T> {
  entries: readonly T[] | null;
  busy: boolean;
  error: string | null;
}
export interface ForwardingReadData {
  hosts: ConnectionPromptHost[];
  hostsLoading: boolean;
  sessions: Pick<SshSession, "id" | "hostId" | "purpose">[];
  rules: ForwardingReadSnapshot<ForwardInfo>;
  groups: ForwardingReadSnapshot<ForwardGroup>;
}
