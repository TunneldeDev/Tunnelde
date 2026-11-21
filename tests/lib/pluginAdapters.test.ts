import { expect, it, vi } from "vitest";
import { synchronizePluginAdapters } from "@/lib/panels/pluginAdapters";
import type { NativePanelSnapshot, NativePluginViewDescriptor } from "@/lib/panels/windowProtocol";
const descriptor: NativePluginViewDescriptor = {
  panelId: "plugin:sample:files",
  revision: "approved",
  pluginId: "sample",
  runtimeId: "r1",
  generation: 4,
  viewId: "files",
  entry: "index.mjs",
  sdkVersion: "0.1.0",
  title: "Sample",
  allowFloating: true,
};
const snapshot = (views = [descriptor]): NativePanelSnapshot => ({
  windows: [],
  transfers: [],
  pluginViews: views,
  panels: [{ panelId: descriptor.panelId, windowId: "main", generation: 1 }],
});
const candidate = {
  panelId: descriptor.panelId,
  viewId: descriptor.viewId,
  owner: {
    pluginId: descriptor.pluginId,
    runtimeId: descriptor.runtimeId,
    generation: descriptor.generation,
    entry: descriptor.entry,
    sdkVersion: descriptor.sdkVersion,
  },
};
it("keeps exact approvals stable across snapshots, avoids registration loops and ignores unregistered panels", async () => {
  const client = { registerAdapter: vi.fn(), unregisterAdapter: vi.fn() };
  await synchronizePluginAdapters(client, snapshot(), [candidate]);
  await synchronizePluginAdapters(client, { ...snapshot(), panels: [], pluginViews: [] }, [
    candidate,
  ]);
  expect(client.registerAdapter).not.toHaveBeenCalled();
  expect(client.unregisterAdapter).not.toHaveBeenCalled();
});
it("withdraws exact prior approvals before admitting a replacement, without passing activation data", async () => {
  const events: string[] = [];
  const client = {
    registerAdapter: vi.fn(async () => {
      events.push("register");
      return descriptor;
    }),
    unregisterAdapter: vi.fn(async () => {
      events.push("unregister");
      return true;
    }),
  };
  await synchronizePluginAdapters(client, snapshot(), [
    { ...candidate, owner: { ...candidate.owner, runtimeId: "r2" } },
  ]);
  expect(events).toEqual(["unregister", "register"]);
  expect(client.unregisterAdapter).toHaveBeenCalledWith(descriptor);
  expect(client.registerAdapter).toHaveBeenCalledWith("sample", "r2", "files");
});
it("withdraws factory approvals when selection no longer advertises a native candidate", async () => {
  const client = { registerAdapter: vi.fn(), unregisterAdapter: vi.fn() };
  await synchronizePluginAdapters(client, snapshot(), []);
  expect(client.unregisterAdapter).toHaveBeenCalledExactlyOnceWith(descriptor);
  expect(client.registerAdapter).not.toHaveBeenCalled();
});
