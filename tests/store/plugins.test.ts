// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginInfo } from "@/lib/api/types";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    pluginsList: vi.fn(),
    pluginReload: vi.fn(),
    pluginInstall: vi.fn(),
    pluginStart: vi.fn(),
    pluginStop: vi.fn(),
    pluginRun: vi.fn(),
  },
}));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));

import { usePlugins } from "@/store/plugins";

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
  usePlugins.setState({
    items: [plugin],
    busy: null,
    busyIds: [],
    reloading: false,
    outputs: {},
  });
});

describe("plugin request ownership", () => {
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
