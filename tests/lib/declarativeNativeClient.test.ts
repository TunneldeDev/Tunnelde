import { expect, it, vi } from "vitest";
import { createNativeDeclarativeClient } from "@/lib/plugins/views/declarativeNative";
const descriptor = {
  panelId: "plugin:sample:files",
  revision: "approval",
  pluginId: "sample",
  runtimeId: "runtime:8",
  generation: 4,
  viewId: "files",
  title: "Sample",
  allowFloating: true,
  renderer: "json" as const,
};
const record = {
  key: "lease:4",
  staged: false,
  lease: { panelId: descriptor.panelId, windowId: "main", generation: 4 },
};
function fixture(windowId = "main") {
  const invoke = vi.fn(async (_command: string, _args: unknown) => {
    if ((_args as { request: { action: string } }).request.action === "registerDeclarativeAdapter")
      return descriptor;
    if ((_args as { request: { action: string } }).request.action === "openDeclarative")
      return {
        token: "attachment",
        pluginId: "sample",
        generation: 4,
        runtimeId: "runtime:8",
        viewId: "files",
        title: "Sample",
        renderer: "json",
      };
    if ((_args as { request: { action: string } }).request.action === "renderDeclarative")
      return { title: "Tool", blocks: [] };
    return null;
  });
  const client = createNativeDeclarativeClient(
    { windowId, document: "exact-document" },
    { invoke: invoke as never, report: vi.fn() },
  );
  return { client, invoke };
}
it("registers and opens JSON presentation without frontend module or activation metadata", async () => {
  const f = fixture();
  expect(await f.client.registerAdapter("sample", "runtime:8", "files")).toEqual(descriptor);
  expect(await f.client.open(record, descriptor)).toMatchObject({ renderer: "json" });
  expect(await f.client.render(record, "en-US")).toEqual({ title: "Tool", blocks: [] });
  expect(
    f.invoke.mock.calls.map(([, args]) => (args as { request: { action: string } }).request.action),
  ).toEqual(["registerDeclarativeAdapter", "openDeclarative", "renderDeclarative"]);
  for (const [, args] of f.invoke.mock.calls) {
    expect(args).not.toHaveProperty("windowId");
    expect(args).not.toHaveProperty("activation");
    expect(args).not.toHaveProperty("permissions");
  }
  f.client.dispose();
  await expect(f.client.render(record, "en-US")).rejects.toThrow("disposed");
  expect(
    f.invoke.mock.calls.filter(
      ([, args]) => (args as { request: { action: string } }).request.action === "closeDeclarative",
    ),
  ).toHaveLength(1);
});
it("is coordinator-only for admission and snapshots target leases before IPC", async () => {
  const satellite = fixture("satellite");
  await expect(satellite.client.registerAdapter("sample", "runtime:8", "files")).rejects.toThrow(
    "coordinatorRequired",
  );
  expect(satellite.invoke).not.toHaveBeenCalled();
  satellite.client.dispose();
  const f = fixture();
  const mutable = {
    ...record,
    lease: { ...record.lease },
  };
  const pending = f.client.render(mutable, "en-US");
  mutable.lease.generation = 99;
  await pending;
  expect(f.invoke).toHaveBeenLastCalledWith("panel_window_plugin_view", {
    document: "exact-document",
    request: {
      action: "renderDeclarative",
      target: {
        kind: "owned",
        lease: { panelId: descriptor.panelId, windowId: "main", generation: 4 },
      },
      locale: "en-US",
    },
  });
  f.client.dispose();
});
