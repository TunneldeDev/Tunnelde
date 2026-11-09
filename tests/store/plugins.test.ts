import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginInfo } from "@/lib/api/types";

const { apiMock, native, ensureNode, ensurePermission, frontend } = vi.hoisted(() => ({
  native: vi.fn(() => false),
  ensureNode: vi.fn(),
  ensurePermission: vi.fn(),
  frontend: { ensure: vi.fn(), stop: vi.fn() },
  apiMock: {
    pluginsList: vi.fn(),
    pluginReload: vi.fn(),
    pluginInstall: vi.fn(),
    pluginStart: vi.fn(),
    pluginStop: vi.fn(),
    pluginRun: vi.fn(),
    pluginUninstall: vi.fn(),
    marketplaceDownload: vi.fn(),
    openLatestLog: vi.fn(),
  },
}));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock, isTauri: native }));
vi.mock("@/features/plugins/NodeRuntimeSection", () => ({ ensureNodeRuntime: ensureNode }));
vi.mock("@/store/pluginSecurity", () => ({
  ensurePluginPermission: ensurePermission,
  reportPluginExecutionFailure: vi.fn(),
}));
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));
vi.mock("@/lib/extensions/frontendRuntime", () => ({ frontendRuntime: frontend }));

import { usePlugins } from "@/store/plugins";
import { toast } from "@/store/toasts";

const plugin: PluginInfo = {
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  apiVersion: 1,
  description: null,
  commands: [],
  views: [],
  permissions: [],
  status: "stopped",
  error: null,
  path: "plugins/hello",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.mockReturnValue(false);
  ensurePermission.mockResolvedValue(true);
  usePlugins.setState({
    items: [plugin],
    busy: null,
    busyIds: [],
    reloading: false,
    outputs: {},
  });
});

describe("plugin request ownership", () => {
  it("starts a pure frontend without Node and stops its backend if activation fails", async () => {
    native.mockReturnValue(true);
    const ui = {
      ...plugin,
      runtime: "frontend" as const,
      frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
    };
    usePlugins.setState({ items: [ui] });
    apiMock.pluginStart.mockResolvedValueOnce({ ...ui, status: "running" });
    apiMock.pluginsList.mockResolvedValueOnce([{ ...ui, status: "failed" }]);
    frontend.ensure.mockRejectedValueOnce(new Error("plugin.frontend.missingActivate"));
    await usePlugins.getState().start(plugin.id);
    expect(ensurePermission).toHaveBeenCalledWith(ui);
    expect(ensureNode).not.toHaveBeenCalled();
    expect(apiMock.pluginStop).not.toHaveBeenCalled();
    expect(apiMock.pluginsList).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("activate"),
      "error",
      expect.any(Object),
    );
  });
  it("reports an unknown plugin startup validation error and offers the log", async () => {
    apiMock.pluginStart.mockRejectedValueOnce({
      code: "validation",
      message: "plugin.spawn: executable missing",
    });
    await usePlugins.getState().start(plugin.id);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("executable missing"),
      "error",
      expect.objectContaining({ label: expect.any(String), onClick: expect.any(Function) }),
    );
    const action = vi.mocked(toast).mock.calls.at(-1)?.[2];
    await action?.onClick();
    expect(apiMock.openLatestLog).toHaveBeenCalledOnce();
  });
  it("reports initialization failure returned as plugin state", async () => {
    apiMock.pluginStart.mockResolvedValueOnce({
      ...plugin,
      status: "failed",
      error: "plugin.error: Invalid saved configuration",
    });
    await usePlugins.getState().start(plugin.id);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("Invalid saved configuration"),
      "error",
      expect.any(Object),
    );
    expect(usePlugins.getState().items[0]?.status).toBe("failed");
  });
  it("does not construct command input or invoke a plugin before permission is granted", async () => {
    native.mockReturnValue(true);
    usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
    const approval = deferred<boolean>();
    ensurePermission.mockReturnValue(approval.promise);
    const input = vi.fn(() => ({ path: "/private/file" }));
    const request = usePlugins.getState().execute(plugin.id, "inspect", input);
    await vi.waitFor(() => expect(ensurePermission).toHaveBeenCalledOnce());
    expect(input).not.toHaveBeenCalled();
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
    approval.resolve(false);
    await expect(request).rejects.toThrow("plugin.permissionDenied");
    expect(input).not.toHaveBeenCalled();
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
  });

  it("does not execute against a plugin replaced while permission is pending", async () => {
    native.mockReturnValue(true);
    usePlugins.setState({ items: [{ ...plugin, status: "running", fingerprint: "original" }] });
    const approval = deferred<boolean>();
    ensurePermission.mockReturnValue(approval.promise);
    const input = vi.fn(() => ({ path: "/private/file" }));
    const request = usePlugins.getState().execute(plugin.id, "inspect", input);
    await vi.waitFor(() => expect(ensurePermission).toHaveBeenCalledOnce());
    usePlugins.setState({ items: [{ ...plugin, status: "running", fingerprint: "replacement" }] });
    approval.resolve(true);
    await expect(request).rejects.toThrow();
    expect(input).not.toHaveBeenCalled();
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
  });
  it("does not inspect Node or start execution after permission is denied", async () => {
    native.mockReturnValue(true);
    ensurePermission.mockResolvedValueOnce(false);
    await usePlugins.getState().start(plugin.id);
    expect(ensurePermission).toHaveBeenCalledWith(plugin);
    expect(ensureNode).not.toHaveBeenCalled();
    expect(apiMock.pluginStart).not.toHaveBeenCalled();
  });
  it("never invokes Node setup or an executable startup for pure theme packs", async () => {
    native.mockReturnValue(true);
    const theme = {
      ...plugin,
      runtime: "theme" as const,
      themes: [{ id: "dark", name: "Dark", appearance: "dark" as const, colors: {} }],
    };
    usePlugins.setState({ items: [theme] });
    await usePlugins.getState().start(theme.id);
    expect(ensureNode).not.toHaveBeenCalled();
    expect(apiMock.pluginStart).not.toHaveBeenCalled();
    expect(usePlugins.getState().items).toEqual([theme]);
    expect(usePlugins.getState().busyIds).toEqual([]);
  });
  it("does not resurrect an uninstalled plugin from an earlier discovery request", async () => {
    const snapshot = deferred<PluginInfo[]>();
    apiMock.pluginsList.mockReturnValue(snapshot.promise);
    apiMock.pluginUninstall.mockResolvedValue(undefined);
    const refresh = usePlugins.getState().load();
    await usePlugins.getState().uninstall(plugin.id);
    snapshot.resolve([plugin]);
    await refresh;
    expect(usePlugins.getState().items).toEqual([]);
  });

  it("deduplicates starts while Node setup is pending and leaves the runtime unchanged on cancellation", async () => {
    native.mockReturnValue(true);
    const setup = deferred<boolean>();
    ensureNode.mockReturnValue(setup.promise);
    const first = usePlugins.getState().start(plugin.id);
    expect(usePlugins.getState().start(plugin.id)).toBe(first);
    expect(usePlugins.getState().stop(plugin.id)).toBe(first);
    await vi.waitFor(() => expect(ensureNode).toHaveBeenCalledOnce());
    setup.resolve(false);
    await first;
    expect(apiMock.pluginStart).not.toHaveBeenCalled();
    expect(usePlugins.getState().items).toEqual([plugin]);
    expect(usePlugins.getState().busyIds).toEqual([]);
  });
  it("keeps another plugin busy when the first operation completes", async () => {
    const first = deferred<PluginInfo>();
    const second = deferred<PluginInfo>();
    apiMock.pluginStart.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const start = usePlugins.getState().start("hello");
    const duplicate = usePlugins.getState().start("hello");
    const conflicting = usePlugins.getState().stop("hello");
    const other = usePlugins.getState().start("second");
    expect(duplicate).toBe(start);
    expect(conflicting).toBe(start);
    expect(usePlugins.getState().busyIds).toEqual(["hello", "second"]);
    await Promise.resolve();
    expect(apiMock.pluginStart).toHaveBeenCalledTimes(2);
    expect(apiMock.pluginStop).not.toHaveBeenCalled();
    first.resolve({ ...plugin, status: "running" });
    await start;
    expect(usePlugins.getState().busyIds).toEqual(["second"]);
    second.resolve({ ...plugin, id: "second", status: "running" });
    await other;
    expect(usePlugins.getState().busyIds).toEqual([]);
    expect(usePlugins.getState().busy).toBeNull();
  });

  it("does not let an older list overwrite a newer snapshot", async () => {
    const older = deferred<PluginInfo[]>();
    const newer = deferred<PluginInfo[]>();
    apiMock.pluginsList.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = usePlugins.getState().load();
    const second = usePlugins.getState().load();
    newer.resolve([{ ...plugin, version: "2.0.0" }]);
    await second;
    older.resolve([plugin]);
    await first;
    expect(usePlugins.getState().items[0]?.version).toBe("2.0.0");
  });

  it("preserves newer status events and newly discovered plugins during a list request", async () => {
    const snapshot = deferred<PluginInfo[]>();
    apiMock.pluginsList.mockReturnValue(snapshot.promise);
    const request = usePlugins.getState().load();
    const failed = { ...plugin, status: "failed" as const, error: "crashed" };
    usePlugins.getState().apply(failed);
    usePlugins.getState().apply({ ...plugin, id: "new-plugin" });
    snapshot.resolve([plugin]);
    await request;
    expect(usePlugins.getState().items).toEqual([failed, { ...plugin, id: "new-plugin" }]);
  });

  it("does not replace a pushed failure with an older successful start response", async () => {
    const response = deferred<PluginInfo>();
    apiMock.pluginStart.mockReturnValue(response.promise);
    const request = usePlugins.getState().start("hello");
    await Promise.resolve();
    const failed = { ...plugin, status: "failed" as const, error: "crashed" };
    usePlugins.getState().apply(failed);
    response.resolve({ ...plugin, status: "running" });
    await request;
    expect(usePlugins.getState().items).toEqual([failed]);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("crashed"),
      "error",
      expect.any(Object),
    );
  });

  it("deduplicates reloads and waits for a running command before replacing the runtime", async () => {
    const command = deferred<unknown>();
    const reload = deferred<PluginInfo[]>();
    apiMock.pluginRun.mockReturnValue(command.promise);
    apiMock.pluginReload.mockReturnValue(reload.promise);
    const run = usePlugins.getState().run("hello", "build");
    const refresh = usePlugins.getState().reload();
    expect(usePlugins.getState().reload()).toBe(refresh);
    expect(usePlugins.getState().load()).toBe(refresh);
    expect(usePlugins.getState().reloading).toBe(true);
    await Promise.resolve();
    expect(apiMock.pluginReload).not.toHaveBeenCalled();
    command.resolve({ ok: true });
    await run;
    await vi.waitFor(() => expect(apiMock.pluginReload).toHaveBeenCalledTimes(1));
    reload.resolve([{ ...plugin, version: "2.0.0" }]);
    await refresh;
    expect(usePlugins.getState().reloading).toBe(false);
    expect(usePlugins.getState().outputs.hello?.text).toContain('"ok": true');
    expect(usePlugins.getState().items[0]?.version).toBe("2.0.0");
  });

  it("keeps a successful install when the subsequent discovery refresh fails", async () => {
    const installed = { ...plugin, id: "installed" };
    apiMock.pluginInstall.mockResolvedValue(installed);
    apiMock.pluginsList.mockRejectedValue(new Error("temporary list failure"));
    const first = usePlugins.getState().install("hello.zip");
    expect(usePlugins.getState().install("hello.zip")).toBe(first);
    expect(await first).toBe(true);
    expect(apiMock.pluginInstall).toHaveBeenCalledTimes(1);
    expect(usePlugins.getState().items).toContainEqual(installed);
  });
});
