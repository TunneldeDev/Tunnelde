import { ResourceScopeError } from "../scopes/errors";

export type NativeRequestInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export interface ScopedRequestTransport {
  prepare(token: string): Promise<string>;
  cancel(token: string, requestId: string): Promise<unknown>;
  call<T>(
    token: string,
    requestId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T>;
}

/** Reserve first so a cancellation racing dispatch cannot be lost. Late
 * reservation replies are released too. Native effects are not rolled back. */
export async function callScopedRequest<T>(
  transport: ScopedRequestTransport,
  report: (error: unknown) => void,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new ResourceScopeError("extension.scope.cancelled");
  const requestId = await transport.prepare(token);
  let released = false;
  const cancel = () => {
    if (released) return;
    released = true;
    const failed = (error: unknown) => {
      try {
        report(error);
      } catch {
        /* Cleanup must settle. */
      }
    };
    try {
      void transport.cancel(token, requestId).catch(failed);
    } catch (error) {
      failed(error);
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new ResourceScopeError("extension.scope.cancelled");
    return await transport.call<T>(token, requestId, method, params);
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

/** Existing coordinator transport retains its stable native commands. */
export function callFrontend<T>(
  invoke: NativeRequestInvoke,
  report: (error: unknown) => void,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return callScopedRequest<T>(
    {
      prepare: (token) => invoke<string>("plugin_frontend_prepare_call", { token }),
      cancel: (token, requestId) => invoke("plugin_frontend_cancel_call", { token, requestId }),
      call: <R>(
        token: string,
        requestId: string,
        method: string,
        params: Record<string, unknown>,
      ) => invoke<R>("plugin_frontend_call", { token, requestId, method, params }),
    },
    report,
    token,
    method,
    params,
    signal,
  );
}
