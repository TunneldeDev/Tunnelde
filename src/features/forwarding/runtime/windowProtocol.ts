import type { ConnectionReview } from "@/lib/api/connections/review";
import type { ConnectionPromptHost } from "@/features/connect/prompt";
import type { ForwardAutomation } from "../model/contract";
import type { forwardingSavePayload } from "../model/payload";

export interface ForwardingWindowCredentials {
  password?: string | null;
  passphrase?: string | null;
  jumps?: Record<string, { password?: string | null; passphrase?: string | null }>;
}
export interface ForwardingWindowStartPlan {
  host: ConnectionPromptHost;
  jumpHosts: ConnectionPromptHost[];
  review: ConnectionReview;
}

/** Private builtin-only grammar. No provider origin/handle, raw
 * command name or caller-selected window. Prompt/provider adapters remain
 * separate work; this is not a complete ForwardingActions implementation. */
export type ForwardingWindowMutation =
  | { operation: "prepareStart"; id: string; revision: string; interaction: string }
  | {
      operation: "start";
      id: string;
      revision: string;
      interaction: string;
      review: ConnectionReview;
      /** Ephemeral direct IPC only: never checkpoint, publish or broadcast. */
      credentials?: ForwardingWindowCredentials;
    }
  | {
      operation: "save";
      rule: ReturnType<typeof forwardingSavePayload>;
      revision: string | null;
      groupId: string | null;
      automation: ForwardAutomation;
      /** Exact originating panel interaction for non-loopback exposure consent. */
      interaction?: string;
    }
  | { operation: "stop"; id: string; revision: string; runtimeId: string | null }
  | {
      operation: "remove";
      id: string;
      revision: string;
      runtimeId: string | null;
      /** Original deletion-confirmation interaction, never a later replacement. */
      interaction: string;
    }
  | {
      operation: "saveGroup";
      hostId: string;
      name: string;
      id?: string;
      revision?: string;
    }
  | { operation: "removeGroup"; id: string; revision: string };
