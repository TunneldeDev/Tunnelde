import { ResourceScopeError } from "../../resourceScope";

export type NativeRequestInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Reserve first so a cancellation racing dispatch cannot be lost. Late
 * reservation replies are released too. Native effects are not rolled back. */
export async function callFrontend<T>(
  invoke: NativeRequestInvoke,
  report: (error: unknown) => void,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new ResourceScopeError("extension.scope.cancelled");
  const requestId = await invoke<string>("plugin_frontend_prepare_call", { token });
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
      void invoke("plugin_frontend_cancel_call", { token, requestId }).catch(failed);
    } catch (error) {
      failed(error);
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new ResourceScopeError("extension.scope.cancelled");
    return await invoke<T>("plugin_frontend_call", { token, requestId, method, params });
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}
