import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSecurityState } from "@/lib/api/types";
import type { usePluginSecurity as SecurityStore } from "@/store/pluginSecurity";
import { deferred, plugin, themePack } from "../fixtures/plugins";
const mock = vi.hoisted(() => ({
  api: {
    pluginSecurityState: vi.fn(),
    pluginSetRestricted: vi.fn(),
    pluginSetPermissions: vi.fn(),
    pluginsList: vi.fn(),
  },
  toast: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: mock.api, isTauri: () => true }));
vi.mock("@/store/toasts", () => ({ toast: mock.toast }));
let usePluginSecurity: typeof SecurityStore;
let state: PluginSecurityState;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  state = {
    restricted: false,
    cliLocked: false,
    recoverySuggested: false,
    reason: null,
    grants: {},
  };
  mock.api.pluginSecurityState.mockImplementation(async () => state);
  mock.api.pluginsList.mockResolvedValue([]);
  mock.api.pluginSetRestricted.mockImplementation(
    async (enabled: boolean) => (state = { ...state, restricted: enabled }),
  );
  mock.api.pluginSetPermissions.mockImplementation(
    async (id: string, permissions: string[] | null) => {
      const grants = { ...state.grants };
      if (permissions === null) delete grants[id];
      else grants[id] = permissions;
      state = { ...state, grants };
    },
  );
  ({ usePluginSecurity } = await import("@/store/pluginSecurity"));
});

describe("plugin security authorization", () => {
  it("keeps the specific startup error in the recovery dialog", async () => {
    const { reportPluginExecutionFailure } = await import("@/store/pluginSecurity");
    reportPluginExecutionFailure({
      code: "validation",
      message: "plugin.error: Invalid saved configuration",
    });
    expect(usePluginSecurity.getState().failure).toBe("Invalid saved configuration");
  });
  it("does not recreate a cancelled prompt when a delayed initial load finishes after modes change", async () => {
    const response = deferred<PluginSecurityState>();
    mock.api.pluginSecurityState.mockReturnValueOnce(response.promise);
    const request = usePluginSecurity.getState().ensure(plugin);
    await vi.waitFor(() => expect(mock.api.pluginSecurityState).toHaveBeenCalledOnce());
    usePluginSecurity.getState().apply({ ...state, restricted: true });
    usePluginSecurity.getState().apply(state);
    response.resolve(state);
    expect(await request).toBe(false);
    expect(usePluginSecurity.getState().prompts).toEqual([]);
  });

  it("does not repeat a protected-startup suggestion on subsequent security events", () => {
    const protectedState = { ...state, restricted: true, recoverySuggested: true };
    usePluginSecurity.getState().apply(protectedState);
    expect(usePluginSecurity.getState().recoveryPrompt).toBe("startup");
    usePluginSecurity.getState().dismissRecovery();
    usePluginSecurity.getState().apply(protectedState);
    expect(usePluginSecurity.getState().recoveryPrompt).toBeNull();
  });

  it("keeps a newer pushed mode when an earlier toggle response arrives", async () => {
    const response = deferred<PluginSecurityState>();
    mock.api.pluginSetRestricted.mockReturnValueOnce(response.promise);
    const request = usePluginSecurity.getState().setRestricted(true);
    usePluginSecurity.getState().apply({ ...state, cliLocked: true, restricted: true });
    response.resolve({ ...state, restricted: true });
    await request;
    expect(usePluginSecurity.getState().state.cliLocked).toBe(true);
  });
  it("never approves updated package contents using a stale permission dialog fingerprint", async () => {
    const request = usePluginSecurity.getState().ensure(plugin);
    await vi.waitFor(() => expect(usePluginSecurity.getState().prompts).toHaveLength(1));
    mock.api.pluginSetPermissions.mockRejectedValueOnce({
      code: "validation",
      message: "pluginSecurity.changed",
    });
    expect(await usePluginSecurity.getState().approve(plugin.id)).toBe(false);
    expect(mock.api.pluginSetPermissions).toHaveBeenCalledWith(plugin.id, [], plugin.fingerprint);
    expect(await request).toBe(false);
    expect(usePluginSecurity.getState().prompts).toEqual([]);
    expect(usePluginSecurity.getState().state.grants).toEqual({});
    expect(mock.api.pluginsList).toHaveBeenCalledOnce();
  });

  it("does not auto-accept a pending package snapshot when grants arrive from another window", async () => {
    const request = usePluginSecurity.getState().ensure(plugin);
    await vi.waitFor(() => expect(usePluginSecurity.getState().prompts).toHaveLength(1));
    usePluginSecurity.getState().apply({ ...state, grants: { [plugin.id]: [] } });
    expect(usePluginSecurity.getState().prompts).toHaveLength(1);
    usePluginSecurity.getState().deny(plugin.id);
    expect(await request).toBe(false);
  });

  it("suggests recovery only for genuine execution failures and only once for the same failure", async () => {
    const { reportPluginExecutionFailure } = await import("@/store/pluginSecurity");
    reportPluginExecutionFailure(new Error("Invalid JSON"));
    reportPluginExecutionFailure({ message: "plugin.input.invalid" });
    reportPluginExecutionFailure({ message: "pluginSecurity.blocked" });
    reportPluginExecutionFailure({ message: "market.network" });
    expect(usePluginSecurity.getState().recoveryPrompt).toBeNull();
    reportPluginExecutionFailure({ code: "validation", message: "plugin.timeout" });
    expect(usePluginSecurity.getState().recoveryPrompt).toBe("failure");
    usePluginSecurity.getState().dismissRecovery();
    reportPluginExecutionFailure({ code: "validation", message: "plugin.timeout" });
    expect(usePluginSecurity.getState().recoveryPrompt).toBeNull();
    reportPluginExecutionFailure({ code: "validation", message: "plugin.wasm.trap: unreachable" });
    expect(usePluginSecurity.getState().recoveryPrompt).toBe("failure");
  });
  it("requires explicit approval even for zero host permissions and deduplicates concurrent requests", async () => {
    const first = usePluginSecurity.getState().ensure(plugin);
    expect(usePluginSecurity.getState().ensure(plugin)).toBe(first);
    await vi.waitFor(() => expect(usePluginSecurity.getState().prompts).toEqual([plugin]));
    expect(mock.api.pluginSetPermissions).not.toHaveBeenCalled();
    expect(await usePluginSecurity.getState().approve(plugin.id)).toBe(true);
    expect(mock.api.pluginSetPermissions).toHaveBeenCalledWith(plugin.id, [], plugin.fingerprint);
    expect(await first).toBe(true);
    expect(usePluginSecurity.getState().prompts).toEqual([]);
    expect(await usePluginSecurity.getState().ensure(plugin)).toBe(true);
    expect(mock.api.pluginSetPermissions).toHaveBeenCalledOnce();
  });

  it("asks again when a plugin requests additional permissions and does not grant on denial", async () => {
    state.grants[plugin.id] = [];
    const upgraded = { ...plugin, permissions: ["clipboard.read"] };
    const request = usePluginSecurity.getState().ensure(upgraded);
    await vi.waitFor(() => expect(usePluginSecurity.getState().prompts).toEqual([upgraded]));
    usePluginSecurity.getState().deny(plugin.id);
    expect(await request).toBe(false);
    expect(state.grants[plugin.id]).toEqual([]);
    expect(mock.api.pluginSetPermissions).not.toHaveBeenCalled();
  });

  it("never prompts for theme data, and blocks executable code in restricted mode", async () => {
    state.restricted = true;
    expect(await usePluginSecurity.getState().ensure(themePack)).toBe(true);
    expect(mock.api.pluginSecurityState).not.toHaveBeenCalled();
    expect(await usePluginSecurity.getState().ensure(plugin)).toBe(false);
    expect(usePluginSecurity.getState().prompts).toEqual([]);
  });

  it("rejects pending permission prompts when restricted mode is enabled", async () => {
    const first = usePluginSecurity.getState().ensure(plugin);
    const second = usePluginSecurity.getState().ensure({ ...plugin, id: "other" });
    await vi.waitFor(() => expect(usePluginSecurity.getState().prompts).toHaveLength(2));
    await usePluginSecurity.getState().setRestricted(true);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(usePluginSecurity.getState().prompts).toEqual([]);
    expect(mock.api.pluginSetPermissions).not.toHaveBeenCalled();
  });

  it("cannot disable a CLI-locked process and revokes grants with null", async () => {
    state = { ...state, restricted: true, cliLocked: true, grants: { formatter: [] } };
    await usePluginSecurity.getState().load();
    expect(await usePluginSecurity.getState().setRestricted(false)).toBe(false);
    expect(mock.api.pluginSetRestricted).not.toHaveBeenCalled();
    expect(await usePluginSecurity.getState().revoke(plugin.id)).toBe(true);
    expect(mock.api.pluginSetPermissions).toHaveBeenCalledWith(plugin.id, null, null);
    expect(usePluginSecurity.getState().state.grants).toEqual({});
  });

  it("fails closed if settings cannot be read and can retry without a stuck loading state", async () => {
    mock.api.pluginSecurityState.mockRejectedValueOnce(new Error("Cannot verify permissions"));
    expect(await usePluginSecurity.getState().ensure(plugin)).toBe(false);
    expect(usePluginSecurity.getState().loading).toBe(false);
    expect(usePluginSecurity.getState().ready).toBe(false);
    expect(mock.toast).toHaveBeenCalledWith("Cannot verify permissions", "error");
    await usePluginSecurity.getState().load(true);
    expect(usePluginSecurity.getState().ready).toBe(true);
    expect(usePluginSecurity.getState().error).toBeNull();
  });

  it("keeps a newer security event when an older settings snapshot arrives", async () => {
    const snapshot = deferred<PluginSecurityState>();
    mock.api.pluginSecurityState.mockReturnValueOnce(snapshot.promise);
    const load = usePluginSecurity.getState().load();
    await vi.waitFor(() => expect(mock.api.pluginSecurityState).toHaveBeenCalledOnce());
    usePluginSecurity.getState().apply({ ...state, restricted: true, cliLocked: true });
    snapshot.resolve(state);
    await load;
    expect(usePluginSecurity.getState().state.restricted).toBe(true);
    expect(usePluginSecurity.getState().state.cliLocked).toBe(true);
  });

  it("keeps a failed grant pending for retry instead of silently approving", async () => {
    const request = usePluginSecurity.getState().ensure(plugin);
    await vi.waitFor(() => expect(usePluginSecurity.getState().prompts).toHaveLength(1));
    mock.api.pluginSetPermissions.mockRejectedValueOnce(new Error("Grant write failed"));
    expect(await usePluginSecurity.getState().approve(plugin.id)).toBe(false);
    expect(usePluginSecurity.getState().error).toBe("Grant write failed");
    expect(usePluginSecurity.getState().prompts).toHaveLength(1);
    usePluginSecurity.getState().deny(plugin.id);
    expect(await request).toBe(false);
  });
});
