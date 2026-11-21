import { api, isTauri } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import { authorizePluginAction } from "@/store/pluginSecurity";
import { PluginInvocationCancelled, withPluginInvocation } from "../commands/runtime";
import {
  normalizeBlocks,
  normalizeResult,
  PLUGIN_INPUT_MAX_BYTES,
  viewTitle,
  type PluginBlock,
} from "../pluginView";
import { renderOwnedPluginView } from "./render";

export interface DeclarativePluginView {
  /** Display incarnation, not a capability or persisted layout identifier. */
  revision: string;
  title: string;
  blocks: PluginBlock[];
}
export interface DeclarativeFormRequest {
  revision: string;
  formId: string;
  actionId: string;
  values: Record<string, string>;
  locale: string;
}

/** Main-owned execution boundary for host-rendered JSON views. The renderer
 * submits displayed IDs, never executable commands or another runtime ID.
 * Construction does not activate a plugin, acquire native resources or subscribe.
 * Native presentation must additionally bind this owner to its exact panel lease;
 * this module alone does not admit a new window or transport secrets in models.
 */
export function createDeclarativeViewOwner(pluginId: string, viewId: string) {
  const original = usePlugins.getState().items.find((plugin) => plugin.id === pluginId);
  const lifetime = new AbortController();
  const pending = new Map<string, AbortController>();
  let current: DeclarativePluginView | null = null;
  let render: AbortController | null = null;
  const check = () => {
    if (lifetime.signal.aborted) throw new PluginInvocationCancelled();
  };
  const scope = (signal?: AbortSignal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (lifetime.signal.aborted || signal?.aborted) abort();
    return {
      controller,
      close() {
        lifetime.signal.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
      },
    };
  };
  return {
    async load(
      locale: string | undefined,
      options: { interactive?: boolean; signal?: AbortSignal } = {},
    ): Promise<DeclarativePluginView | null> {
      check();
      render?.abort();
      const request = scope(options.signal);
      render = request.controller;
      try {
        const payload = await renderOwnedPluginView(original, viewId, locale, {
          ...options,
          signal: request.controller.signal,
        });
        check();
        if (request.controller.signal.aborted || render !== request.controller)
          throw new PluginInvocationCancelled();
        if (payload === null) return null; // Denied refresh preserves the actual displayed view.
        const record = (payload ?? {}) as Record<string, unknown>;
        current = {
          revision: crypto.randomUUID(),
          title: viewTitle(payload),
          blocks: normalizeBlocks(record.blocks),
        };
        // Retire pending UI waits before publishing a replacement incarnation.
        // Already-dispatched plugin effects are not claimed to have rolled back.
        for (const operation of pending.values()) operation.abort();
        return structuredClone(current);
      } finally {
        if (render === request.controller) render = null;
        request.close();
      }
    },
    async run(request: DeclarativeFormRequest, signal?: AbortSignal) {
      check();
      const displayed = current;
      const validate = () => {
        check();
        if (!displayed || current !== displayed || displayed.revision !== request.revision)
          throw new PluginInvocationCancelled();
      };
      validate();
      if (typeof request.locale !== "string")
        throw new Error("plugin.frontend.viewStateUnavailable");
      const form = displayed!.blocks.find(
        (block) => block.type === "form" && block.id === request.formId,
      );
      if (!form || form.type !== "form") throw new Error("plugin.frontend.viewUnavailable");
      const action = form.actions.find((action) => action.id === request.actionId);
      if (!action) throw new Error("plugin.frontend.commandUnavailable");
      if (pending.has(form.id)) throw new Error("plugin.busy");
      // Copy only this rendered form's fields; do not accept caller-supplied
      // command metadata, undeclared fields or an injected _locale field.
      const input: Record<string, string> = Object.fromEntries(
        form.fields.map((field) => {
          const value = Object.prototype.hasOwnProperty.call(request.values, field.id)
            ? request.values[field.id]
            : field.value;
          if (
            typeof value !== "string" ||
            (field.type === "select" && !field.options.some((option) => option.value === value))
          )
            throw new Error("plugin.frontend.viewStateUnavailable");
          return [field.id, value];
        }),
      );
      input._locale = request.locale;
      if (new TextEncoder().encode(JSON.stringify(input)).length > PLUGIN_INPUT_MAX_BYTES)
        throw new Error("inputTooLarge");
      const operation = scope(signal);
      pending.set(form.id, operation.controller);
      try {
        const response = await withPluginInvocation(
          original,
          async (plugin, lifetime, checkRuntime) => {
            if (isTauri() && !(await authorizePluginAction(pluginId, lifetime)))
              throw new Error("plugin.permissionDenied");
            checkRuntime();
            validate();
            return api.pluginRun(pluginId, action.command, input, plugin.runtimeId ?? "");
          },
          operation.controller.signal,
        );
        validate();
        return normalizeResult(response);
      } finally {
        if (pending.get(form.id) === operation.controller) pending.delete(form.id);
        operation.close();
      }
    },
    dispose() {
      lifetime.abort();
      render?.abort();
      current = null;
      for (const operation of pending.values()) operation.abort();
      pending.clear();
    },
  };
}
export type DeclarativeViewOwner = ReturnType<typeof createDeclarativeViewOwner>;
