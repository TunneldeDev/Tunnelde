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
    pluginPrepareStart: vi.fn(),
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
  runtimeId: "boot:1",
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
  apiMock.pluginPrepareStart.mockResolvedValue({ fingerprint: "package", stamp: "boot:1" });
  usePlugins.setState({
    items: [plugin],
    busy: null,
    busyIds: [],
    reloading: false,
    outputs: {},
  });
});

describe("plugin request ownership", () => {
  it("recovers failed and removed runtimes without repeatedly activating an obsolete module", async () => {
    const ui = {
      ...plugin,
      status: "running" as const,
      frontend: { entry: "ui.mjs", sdk: "^0.1.0" },
    };
    usePlugins.setState({ items: [ui, { ...ui, id: "removed" }] });
    const failed = {
      ...ui,
      status: "failed" as const,
      runtimeId: null,
      error: "activation failed",
    };
    apiMock.pluginsList.mockResolvedValueOnce([failed]);
    await usePlugins.getState().refreshActivation();
    expect(usePlugins.getState().items).toEqual([failed]);
  });

  it("recovers an activation event while start is pending and reload waits for that start", async () => {
    const ui = { ...plugin, frontend: { entry: "ui.mjs", sdk: "^0.1.0" } };
    usePlugins.setState({ items: [ui] });
    const started = deferred<PluginInfo>();
    apiMock.pluginStart.mockReturnValueOnce(started.promise);
    const starting = usePlugins.getState().start(ui.id);
    await vi.waitFor(() => expect(apiMock.pluginStart).toHaveBeenCalledOnce());
    const reloading = usePlugins.getState().reload();
    const running = { ...ui, status: "running" as const };
    apiMock.pluginsList.mockResolvedValueOnce([running]);
    await usePlugins.getState().refreshActivation({ id: ui.id, runtimeId: "boot:1" });
    expect(usePlugins.getState().items).toEqual([running]);
    expect(apiMock.pluginReload).not.toHaveBeenCalled();
    apiMock.pluginReload.mockResolvedValueOnce([running]);
    started.resolve(running);
    await starting;
    await reloading;
    expect(frontend.ensure).toHaveBeenCalledWith(running);
  });

  it.each(["failed", "replacement", "removed"])(
    "does not overwrite a newer %s state with an activation snapshot",
    async (change) => {
      const snapshot = deferred<PluginInfo[]>();
      apiMock.pluginsList.mockReturnValueOnce(snapshot.promise);
      const pending = usePlugins
        .getState()
        .refreshActivation({ id: plugin.id, runtimeId: "boot:1" });
      const current: PluginInfo = {
        ...plugin,
        status: change === "failed" ? "failed" : "running",
        runtimeId: change === "replacement" ? "boot:2" : null,
      };
      if (change === "removed") {
        apiMock.pluginUninstall.mockResolvedValueOnce(undefined);
        await usePlugins.getState().uninstall(plugin.id);
      } else usePlugins.getState().apply(current);
      snapshot.resolve([
        { ...plugin, status: "running", frontend: { entry: "ui.mjs", sdk: "^0.1.0" } },
      ]);
      await pending;
      expect(usePlugins.getState().items).toEqual(change === "removed" ? [] : [current]);
    },
  );

  it("only restores the exact requested running frontend and skips pending stops", async () => {
    const ui = {
      ...plugin,
      status: "running" as const,
      frontend: { entry: "ui.mjs", sdk: "^0.1.0" },
    };
    apiMock.pluginsList.mockResolvedValue([ui, { ...ui, id: "other" }]);
    await usePlugins.getState().refreshActivation({ id: plugin.id, runtimeId: "boot:wrong" });
    expect(usePlugins.getState().items).toEqual([plugin]);
    const stopped = deferred<PluginInfo>();
    apiMock.pluginStop.mockReturnValueOnce(stopped.promise);
    const stopping = usePlugins.getState().stop(plugin.id);
    await usePlugins.getState().refreshActivation({ id: plugin.id, runtimeId: "boot:1" });
    expect(usePlugins.getState().items).toEqual([plugin]);
    stopped.resolve(plugin);
    await stopping;
  });

  it("stops a command while consent is pending and never builds input after late approval", async () => {
    native.mockReturnValue(true);
    usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
    const permission = deferred<boolean>();
    ensurePermission.mockReturnValueOnce(permission.promise);
    apiMock.pluginStop.mockResolvedValueOnce(plugin);
    const input = vi.fn(() => ({ secret: "private" }));
    const operation = usePlugins.getState().execute(plugin.id, "inspect", input);
    const rejected = expect(operation).rejects.toThrow("plugin.invocation.cancelled");
    await vi.waitFor(() => expect(ensurePermission).toHaveBeenCalledOnce());
    await usePlugins.getState().stop(plugin.id);
    await rejected;
    expect(apiMock.pluginStop).toHaveBeenCalledOnce();
    permission.resolve(true);
    await Promise.resolve();
    expect(input).not.toHaveBeenCalled();
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("discards an old runtime result after stop and same-package restart without clearing the new operation", async () => {
    usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
    const oldCommand = deferred<unknown>();
    const newCommand = deferred<unknown>();
    apiMock.pluginRun
      .mockReturnValueOnce(oldCommand.promise)
      .mockReturnValueOnce(newCommand.promise);
    apiMock.pluginStop.mockResolvedValueOnce(plugin);
    const old = usePlugins.getState().run(plugin.id, "old");
    await vi.waitFor(() => expect(apiMock.pluginRun).toHaveBeenCalledOnce());
    await usePlugins.getState().stop(plugin.id);
    await old;
    usePlugins.getState().apply({ ...plugin, status: "running", runtimeId: "boot:2" });
    const current = usePlugins.getState().run(plugin.id, "new");
    await vi.waitFor(() => expect(apiMock.pluginRun).toHaveBeenCalledTimes(2));
    expect(apiMock.pluginRun.mock.calls[0]?.[3]).toBe("boot:1");
    expect(apiMock.pluginRun.mock.calls[1]?.[3]).toBe("boot:2");
    oldCommand.resolve({ text: "old output" });
    await Promise.resolve();
    expect(usePlugins.getState().outputs[plugin.id]).toBeUndefined();
    expect(usePlugins.getState().commandingIds).toEqual([plugin.id]);
    newCommand.resolve({ text: "new output" });
    await current;
    expect(usePlugins.getState().outputs[plugin.id]?.text).toBe("new output");
  });

  it("captures execution identity before the operation microtask, including same-package replacement", async () => {
    usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
    const input = vi.fn(() => ({}));
    const operation = usePlugins.getState().execute(plugin.id, "inspect", input);
    usePlugins.getState().apply({ ...plugin, status: "running", runtimeId: "boot:2" });
    await expect(operation).rejects.toThrow("plugin.invocation.cancelled");
    expect(input).not.toHaveBeenCalled();
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
  });

  it("never falls back to an unbound native command when runtime identity is missing", async () => {
    native.mockReturnValue(true);
    usePlugins.setState({ items: [{ ...plugin, status: "running", runtimeId: null }] });
    await expect(usePlugins.getState().execute(plugin.id, "inspect", () => ({}))).rejects.toThrow(
      "pluginSecurity.changed",
    );
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
  });

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
    expect(ensurePermission).toHaveBeenCalledWith(ui, expect.any(AbortSignal));
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
    expect(ensurePermission).toHaveBeenCalledWith(plugin, expect.any(AbortSignal));
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
    const other = usePlugins.getState().start("second");
    expect(duplicate).toBe(start);
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

  it.each(["permission", "node"])(
    "stops while waiting for %s and ignores late approval",
    async (stage) => {
      native.mockReturnValue(true);
      const approval = deferred<boolean>();
      const wait = stage === "permission" ? ensurePermission : ensureNode;
      wait.mockReturnValueOnce(approval.promise);
      const stopped = deferred<PluginInfo>();
      apiMock.pluginStop.mockReturnValueOnce(stopped.promise);
      const start = usePlugins.getState().start(plugin.id);
      await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
      const stop = usePlugins.getState().stop(plugin.id);
      expect(stop).not.toBe(start);
      expect(usePlugins.getState().stop(plugin.id)).toBe(stop);
      const signal = wait.mock.calls[0]!.at(-1) as AbortSignal;
      expect(signal.aborted).toBe(true);
      approval.resolve(true);
      await start;
      expect(apiMock.pluginStart).not.toHaveBeenCalled();
      expect(usePlugins.getState().busyIds).toEqual([plugin.id]);
      stopped.resolve(plugin);
      await stop;
      expect(usePlugins.getState().busyIds).toEqual([]);
      expect(toast).not.toHaveBeenCalled();
    },
  );

  it("stops before the start microtask without requesting consent or native activation", async () => {
    native.mockReturnValue(true);
    apiMock.pluginStop.mockResolvedValueOnce(plugin);
    const start = usePlugins.getState().start(plugin.id);
    await usePlugins.getState().stop(plugin.id);
    await start;
    expect(ensurePermission).not.toHaveBeenCalled();
    expect(apiMock.pluginStart).not.toHaveBeenCalled();
    expect(apiMock.pluginStop).toHaveBeenCalledOnce();
  });

  it("does not use a native permit that arrives after stop", async () => {
    native.mockReturnValue(true);
    const permit = deferred<{ fingerprint: string; stamp: string }>();
    apiMock.pluginPrepareStart.mockReturnValueOnce(permit.promise);
    apiMock.pluginStop.mockResolvedValueOnce(plugin);
    const start = usePlugins.getState().start(plugin.id);
    await vi.waitFor(() => expect(apiMock.pluginPrepareStart).toHaveBeenCalledOnce());
    await usePlugins.getState().stop(plugin.id);
    permit.resolve({ fingerprint: "package", stamp: "old-boot:1" });
    await start;
    expect(ensureNode).not.toHaveBeenCalled();
    expect(apiMock.pluginStart).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not activate stale UI or overwrite a replacement with a cancelled native start response", async () => {
    const old = deferred<PluginInfo>();
    apiMock.pluginStart
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...plugin, status: "running" });
    apiMock.pluginStop.mockResolvedValueOnce(plugin);
    const start = usePlugins.getState().start(plugin.id);
    await vi.waitFor(() => expect(apiMock.pluginStart).toHaveBeenCalledOnce());
    await usePlugins.getState().stop(plugin.id);
    await usePlugins.getState().start(plugin.id);
    old.resolve({
      ...plugin,
      status: "failed",
      error: "old initialization failed",
      frontend: { entry: "ui.mjs", sdk: "^0.1.0" },
    });
    await start;
    expect(usePlugins.getState().items[0]?.status).toBe("running");
    expect(frontend.ensure).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(usePlugins.getState().busyIds).toEqual([]);
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
    usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
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
