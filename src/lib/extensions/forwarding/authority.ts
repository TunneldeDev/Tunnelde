import { invoke } from "@tauri-apps/api/core";
import type { SshConnectRequest, SshSession } from "@/lib/api/types";

export interface ForwardingOrigin {
  token: string;
  scope: string;
}
/** Internal continuation retained by the host editor/dialog, never exposed to plugins. */
export interface ForwardingAuthority {
  authorize(): void;
  origin(): Promise<ForwardingOrigin>;
}

export function createForwardingAuthority(
  token: string,
  viewId: string,
  hostId: string,
  authorize: () => void,
  retain: (release: () => void) => () => void,
): ForwardingAuthority {
  type Attempt = {
    closed: boolean;
    opened?: ForwardingOrigin;
    pending?: Promise<ForwardingOrigin>;
  };
  let current: Attempt | undefined;
  const close = (origin: ForwardingOrigin) => {
    void invoke("forwarding_provider_close", { origin }).catch(() => {});
  };
  const check = () => {
    authorize();
  };
  return Object.freeze({
    authorize: check,
    origin: async () => {
      check();
      if (!current) {
        const attempt: Attempt = { closed: false };
        current = attempt;
        let release: () => void;
        try {
          release = retain(() => {
            attempt.closed = true;
            if (attempt.opened) close(attempt.opened);
            if (current === attempt) current = undefined;
          });
        } catch (error) {
          current = undefined;
          throw error;
        }
        attempt.pending = invoke<string>("forwarding_provider_open", { token, hostId, viewId })
          .then((scope) => {
            const origin = Object.freeze({ token, scope });
            try {
              if (attempt.closed) throw new Error("plugin.forwarding.expired");
              check();
            } catch (error) {
              close(origin);
              throw error;
            }
            attempt.opened = origin;
            return origin;
          })
          .catch((error) => {
            release();
            throw error;
          });
      }
      const attempt = current;
      const origin = await attempt.pending!;
      if (attempt.closed) throw new Error("plugin.forwarding.expired");
      check();
      return origin;
    },
  });
}

/** Exclusive connection path. A late result remains scope-owned until acknowledged. */
export async function connectForwardingProvider(
  authority: ForwardingAuthority,
  request: SshConnectRequest,
): Promise<SshSession> {
  const origin = await authority.origin();
  authority.authorize();
  return invoke("forwarding_provider_connect", { origin, request });
}
