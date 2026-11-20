import type { ForwardAutomation } from "../model/contract";
import type { forwardingSavePayload } from "../model/payload";

/** Private builtin-only grammar. No provider origin/handle, credentials, raw
 * command name or caller-selected window. Connection/removal adapters remain
 * separate work; this is not a complete ForwardingActions implementation. */
export type ForwardingWindowMutation =
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
      operation: "saveGroup";
      hostId: string;
      name: string;
      id?: string;
      revision?: string;
    }
  | { operation: "removeGroup"; id: string; revision: string };
