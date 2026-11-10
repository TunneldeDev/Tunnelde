import { create } from "zustand";
import type { PluginSecurityState } from "@/lib/api/types";
import type { PluginApproval } from "@/lib/plugins/activation/contracts";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { pluginFailure } from "@/lib/plugins/errors";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import { ActivationDecision } from "@/lib/plugins/activation/decision";

const INITIAL: PluginSecurityState = {
  restricted: false,
  cliLocked: false,
  recoverySuggested: false,
  reason: null,
  grants: {},
};

export function hasPluginGrant(state: PluginSecurityState, plugin: PluginApproval): boolean {
  return (
    Object.prototype.hasOwnProperty.call(state.grants, plugin.id) &&
    plugin.permissions.every((permission) => state.grants[plugin.id]!.includes(permission))
  );
}

interface SecurityStore {
  state: PluginSecurityState;
  ready: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  prompts: PluginApproval[];
  failure: string | null;
  recoveryPrompt: "startup" | "failure" | null;
  recoveryDismissed: boolean;
  load: (force?: boolean) => Promise<void>;
  apply: (state: PluginSecurityState) => void;
  ensure: (plugin: PluginApproval, signal?: AbortSignal) => Promise<boolean>;
  approve: (id: string) => Promise<boolean>;
  deny: (id: string) => void;
  setRestricted: (enabled: boolean) => Promise<boolean>;
  revoke: (id: string) => Promise<boolean>;
  reportFailure: (message: string, identity?: string) => void;
  dismissRecovery: () => void;
}

export const usePluginSecurity = create<SecurityStore>((set, get) => {
  let revision = 0;
  let loading: Promise<void> | null = null;
  let mutation = false;
  let startupNotified = false;
  const failures = new Set<string>();
  const requests = new Map<string, { plugin: PluginApproval; decision: ActivationDecision }>();
  const finish = (id: string, allowed: boolean) => {
    const request = requests.get(id);
    request?.decision.finish(allowed);
  };
  const change = async (work: () => Promise<void>): Promise<boolean> => {
    if (mutation) return false;
    mutation = true;
    set({ busy: true, error: null });
    try {
      await work();
      return true;
    } catch (error) {
      set({ error: translateError(error) });
      return false;
    } finally {
      mutation = false;
      set({ busy: false });
    }
  };
  return {
    state: INITIAL,
    ready: false,
    loading: false,
    busy: false,
    error: null,
    prompts: [],
    failure: null,
    recoveryPrompt: null,
    recoveryDismissed: false,
    load: (force = false) => {
      if (loading) return loading;
      if (get().ready && !force) return Promise.resolve();
      const started = revision;
      set({ loading: true, error: null });
      loading = Promise.resolve().then(async () => {
        try {
          const state = isTauri() ? await api.pluginSecurityState() : INITIAL;
          if (revision === started) get().apply(state);
        } catch (error) {
          if (revision === started) set({ error: translateError(error) });
        } finally {
          loading = null;
          set({ loading: false });
        }
      });
      return loading;
    },
    apply: (state) => {
      revision++;
      set({ state, ready: true, error: null });
      if (state.restricted && get().recoveryPrompt === "failure") set({ recoveryPrompt: null });
      if (state.recoverySuggested && !startupNotified) {
        startupNotified = true;
        set({ recoveryPrompt: "startup", recoveryDismissed: false });
      }
      for (const id of requests.keys()) {
        if (state.restricted) finish(id, false);
      }
    },
    ensure: (plugin, signal) => {
      if (signal?.aborted) return Promise.resolve(false);
      if (plugin.runtime === "theme" || !isTauri()) return Promise.resolve(true);
      const existing = requests.get(plugin.id);
      if (existing) {
        if (
          existing.plugin.fingerprint === plugin.fingerprint &&
          existing.plugin.permissions.length === plugin.permissions.length &&
          existing.plugin.permissions.every((value) => plugin.permissions.includes(value))
        )
          return existing.decision.wait(signal);
        existing.decision.finish(false);
      }
      const request = {
        plugin: { ...plugin, permissions: [...plugin.permissions] },
        decision: new ActivationDecision(() => {
          if (requests.get(plugin.id) !== request) return;
          requests.delete(plugin.id);
          set({ prompts: get().prompts.filter((item) => item.id !== plugin.id) });
        }),
      };
      requests.set(plugin.id, request);
      const result = request.decision.wait(signal);
      void Promise.resolve()
        .then(async () => {
          await get().load();
          if (!request.decision.active) return;
          if (!get().ready) {
            toast(get().error ?? i18n.t("pluginSecurity.unavailable"), "error");
            request.decision.finish(false);
            return;
          }
          if (get().state.restricted) {
            toast(i18n.t("pluginSecurity.blocked"), "info");
            request.decision.finish(false);
            return;
          }
          if (hasPluginGrant(get().state, plugin)) request.decision.finish(true);
          else set((state) => ({ prompts: [...state.prompts, request.plugin] }));
        })
        .catch(() => {
          request.decision.finish(false);
        });
      return result;
    },
    approve: async (id) => {
      const request = requests.get(id);
      if (!request || get().state.restricted) return false;
      const result = await change(async () => {
        try {
          await api.pluginSetPermissions(
            id,
            request.plugin.permissions,
            request.plugin.fingerprint ?? null,
          );
        } catch (error) {
          if (errorMessage(error) === "pluginSecurity.changed") {
            if (requests.get(id) === request) finish(id, false);
            const { usePlugins } = await import("@/store/plugins");
            await usePlugins.getState().load();
            await get().load(true);
            toast(i18n.t("pluginSecurity.changed"), "error");
          }
          throw error;
        }
        await get().load(true);
        if (!get().ready || get().state.restricted || !hasPluginGrant(get().state, request.plugin))
          throw new Error(i18n.t("pluginSecurity.changed"));
      });
      if (result && requests.get(id) === request) finish(id, true);
      return result;
    },
    deny: (id) => finish(id, false),
    setRestricted: (enabled) => {
      if (!enabled && get().state.cliLocked) return Promise.resolve(false);
      return change(async () => {
        const started = revision;
        const next = await api.pluginSetRestricted(enabled);
        if (revision === started || JSON.stringify(get().state) === JSON.stringify(next))
          get().apply(next);
        if (enabled) set({ failure: null });
      });
    },
    revoke: (id) =>
      change(async () => {
        await api.pluginSetPermissions(id, null, null);
        await get().load(true);
      }),
    reportFailure: (failure, identity = failure) => {
      if (failures.has(identity)) return;
      failures.add(identity);
      set({
        failure,
        recoveryDismissed: false,
        recoveryPrompt: get().state.restricted ? null : (get().recoveryPrompt ?? "failure"),
      });
    },
    dismissRecovery: () => set({ recoveryDismissed: true, failure: null, recoveryPrompt: null }),
  };
});

export const ensurePluginPermission = (plugin: PluginApproval, signal?: AbortSignal) =>
  usePluginSecurity.getState().ensure(plugin, signal);

function errorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "";
}

export function reportPluginExecutionFailure(error: unknown): void {
  const message = errorMessage(error);
  if (
    /^plugin\.(timeout|exited|spawn|write|error|wasm\.(trap|call|instantiate|memory|response))(?::|$)/.test(
      message,
    )
  ) {
    usePluginSecurity.getState().reportFailure(pluginFailure(error), message);
  }
}

/** Called by explicit tool actions; ordinary view rendering never opens consent dialogs. */
export async function authorizePluginAction(id: string, signal?: AbortSignal): Promise<boolean> {
  if (!isTauri()) return true;
  const { usePlugins } = await import("@/store/plugins");
  if (!usePlugins.getState().items.some((plugin) => plugin.id === id))
    await usePlugins.getState().load();
  const plugin = usePlugins.getState().items.find((plugin) => plugin.id === id);
  return !!plugin && plugin.runtime !== "theme" && ensurePluginPermission(plugin, signal);
}
