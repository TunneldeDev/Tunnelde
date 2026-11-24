import { diagnosticInvoke as invoke } from "@/lib/api/diagnosticInvoke";
import type { PanelLease } from "@/lib/panels/windowProtocol";

export interface NativeDeclarativeDescriptor {
  panelId: string;
  revision: string;
  pluginId: string;
  runtimeId: string;
  generation: number;
  viewId: string;
  title: string;
  allowFloating: boolean;
  renderer: "json";
}
export interface NativeDeclarativeSession {
  token: string;
  pluginId: string;
  generation: number;
  runtimeId: string;
  viewId: string;
  title: string;
  renderer: "json";
}
type Target = { kind: "owned"; lease: PanelLease } | { kind: "staged"; id: string };
type Request =
  | { action: "describeDeclarative"; target: Target }
  | { action: "registerDeclarativeAdapter"; pluginId: string; runtimeId: string; viewId: string }
  | {
      action: "unregisterDeclarativeAdapter";
      panelId: string;
      runtimeId: string;
      generation: number;
      revision: string;
    }
  | {
      action: "openDeclarative";
      target: Target;
      pluginId: string;
      runtimeId: string;
      viewId: string;
    }
  | { action: "renderDeclarative"; target: Target; locale: string | null }
  | {
      action: "runDeclarative";
      target: Target;
      command: string;
      input: Record<string, unknown>;
    }
  | { action: "snapshotDeclarative"; target: Target }
  | { action: "modelDeclarative"; target: Target }
  | { action: "readDeclarativeSecret"; target: Target; key: string }
  | { action: "writeDeclarativeSecret"; target: Target; key: string; value: string }
  | { action: "closeDeclarative"; token: string };
type NativeInvoke = <T>(
  command: "panel_window_plugin_view",
  args: { document: string; request: Request },
) => Promise<T>;
export interface NativeDeclarativeRecord {
  key: string;
  staged: boolean;
  lease?: PanelLease;
}

/** A declarative attachment is not a frontend module. It never loads code or
 * transports a singleton activation token, and its target must still be the
 * exact current panel lease at the native gateway. */
export function createNativeDeclarativeClient(
  identity: { windowId: string; document: string },
  options: { invoke?: NativeInvoke; report: (error: unknown) => void },
) {
  let disposed = false;
  const tokens = new Set<string>();
  const native = options.invoke ?? (invoke as NativeInvoke);
  const request = <T>(request: Request) =>
    native<T>("panel_window_plugin_view", {
      document: identity.document,
      request: structuredClone(request),
    });
  const check = () => {
    if (disposed) throw new Error("panel.window.disposed");
  };
  const target = (record: NativeDeclarativeRecord): Target => {
    if (record.staged) return { kind: "staged", id: record.key };
    if (!record.lease) throw new Error("panel.window.viewNotReady");
    return { kind: "owned", lease: { ...record.lease } };
  };
  return {
    async registerAdapter(pluginId: string, runtimeId: string, viewId: string) {
      check();
      if (identity.windowId !== "main") throw new Error("panel.window.coordinatorRequired");
      const descriptor = await request<NativeDeclarativeDescriptor>({
        action: "registerDeclarativeAdapter",
        pluginId,
        runtimeId,
        viewId,
      });
      check();
      return descriptor;
    },
    async unregisterAdapter(
      descriptor: Pick<
        NativeDeclarativeDescriptor,
        "panelId" | "runtimeId" | "generation" | "revision"
      >,
    ) {
      check();
      if (identity.windowId !== "main") throw new Error("panel.window.coordinatorRequired");
      const changed = await request<boolean>({
        action: "unregisterDeclarativeAdapter",
        panelId: descriptor.panelId,
        runtimeId: descriptor.runtimeId,
        generation: descriptor.generation,
        revision: descriptor.revision,
      });
      check();
      return changed;
    },
    async open(record: NativeDeclarativeRecord, descriptor: NativeDeclarativeDescriptor) {
      check();
      const session = await request<NativeDeclarativeSession>({
        action: "openDeclarative",
        target: target(record),
        pluginId: descriptor.pluginId,
        runtimeId: descriptor.runtimeId,
        viewId: descriptor.viewId,
      });
      tokens.add(session.token);
      if (disposed) {
        tokens.delete(session.token);
        await request({ action: "closeDeclarative", token: session.token }).catch(options.report);
        throw new Error("panel.window.disposed");
      }
      return session;
    },
    async render(record: NativeDeclarativeRecord, locale: string) {
      check();
      const payload = await request<unknown>({
        action: "renderDeclarative",
        target: target(record),
        locale,
      });
      check();
      return payload;
    },
    async run(record: NativeDeclarativeRecord, command: string, input: Record<string, unknown>) {
      check();
      const value = await request<unknown>({
        action: "runDeclarative",
        target: target(record),
        command,
        input,
      });
      check();
      return value;
    },
    async snapshot(record: NativeDeclarativeRecord) {
      check();
      return request<unknown>({ action: "snapshotDeclarative", target: target(record) });
    },
    async model(record: NativeDeclarativeRecord) {
      check();
      return request<unknown>({ action: "modelDeclarative", target: target(record) });
    },
    async readSecret(record: NativeDeclarativeRecord, key: string) {
      check();
      const value = await request<unknown>({
        action: "readDeclarativeSecret",
        target: target(record),
        key,
      });
      check();
      if (typeof value !== "string") throw new Error("panel.viewState.invalid");
      return value;
    },
    async writeSecret(record: NativeDeclarativeRecord, key: string, value: string) {
      check();
      await request<unknown>({
        action: "writeDeclarativeSecret",
        target: target(record),
        key,
        value,
      });
      check();
    },
    describe(record: NativeDeclarativeRecord) {
      check();
      return request<NativeDeclarativeDescriptor | null>({
        action: "describeDeclarative",
        target: target(record),
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const token of tokens)
        void request({ action: "closeDeclarative", token }).catch((error) => {
          try {
            options.report(error);
          } catch {
            /* Cleanup is terminal. */
          }
        });
      tokens.clear();
    },
  };
}
export type NativeDeclarativeClient = ReturnType<typeof createNativeDeclarativeClient>;
