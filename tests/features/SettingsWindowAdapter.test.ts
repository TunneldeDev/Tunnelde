import { afterEach, describe, expect, it, vi } from "vitest";
import { createPanelViewState } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { createSettingsWindowAdapter } from "@/features/settings/window/adapter";
import { createSettingsControlDrafts } from "@/features/settings/window/drafts";
import type { SettingsProjection } from "@/features/settings/window/model";
function fixture(staged = false) {
  const record: WindowViewRecord = {
    key: "owned",
    panelId: "settings-view:test",
    controller: createPanelViewState(),
    staged,
    lease: { panelId: "settings-view:test", windowId: "satellite", generation: 4 },
  };
  useWindowViews.setState({ entries: new Map([[record.panelId, record]]) });
  const control = vi.fn(async () => null),
    action = vi.fn(async () => ({ done: true }));
  const client = { control, action } as unknown as PanelWindowClient;
  const projection = {
    plugins: [{ id: "plugin", fingerprint: "hash" }],
    configurationChanges: [],
  } as unknown as SettingsProjection;
  const drafts = createSettingsControlDrafts();
  return {
    record,
    control,
    action,
    projection,
    drafts,
    adapter: createSettingsWindowAdapter(
      client,
      record,
      drafts,
      projection,
      () => "private-password",
    ),
  };
}
afterEach(() => useWindowViews.setState({ entries: new Map() }));
describe("Settings exact-owner adapter", () => {
  it("serves only detached captured read caches while staged", async () => {
    const f = fixture(true);
    f.drafts.write("configuration:plugin:hash:snapshot", {
      revision: "old",
      values: { draft: true },
    });
    f.drafts.write("recovery:owners", ["one"]);
    const cached = await f.adapter.call("configuration_get", "plugin", "hash");
    expect(cached).toEqual({ revision: "old", values: { draft: true } });
    (cached as unknown as { values: { draft: boolean } }).values.draft = false;
    expect(await f.adapter.call("configuration_get", "plugin", "hash")).toEqual({
      revision: "old",
      values: { draft: true },
    });
    expect(await f.adapter.call("recovery_owners")).toEqual(["one"]);
    await expect(f.adapter.call("configuration_get", "plugin", "new-hash")).rejects.toThrow(
      "pluginSecurity.changed",
    );
    await expect(f.adapter.call("configuration_backups", "plugin", "hash")).rejects.toThrow(
      "panel.window.viewNotReady",
    );
    await expect(f.adapter.call("preference", { theme: "dark" })).rejects.toThrow("staleOwner");
    await expect(
      f.adapter.call("confirm", { title: "confirm", body: "body", confirmLabel: "yes" }),
    ).rejects.toThrow("staleOwner");
    await f.adapter.call("sources_load");
    expect(f.action).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });
  it("promotes the existing adapter without replacing its draft or authority", async () => {
    const f = fixture(true);
    useWindowViews.setState({
      entries: new Map([[f.record.panelId, { ...f.record, staged: false }]]),
    });
    await f.adapter.call("preference", { theme: "dark" });
    expect(f.action).toHaveBeenCalledWith(f.record.lease, {
      kind: "settings",
      command: { operation: "preference", args: [{ theme: "dark" }] },
    });
    const next = {
      ...f.projection,
      configurationChanges: [{ pluginId: "plugin", revision: "changed" }],
    };
    const changed = vi.fn();
    const stop = f.adapter.subscribe(changed);
    f.adapter.publish(next);
    expect(f.adapter.current()).toBe(next);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    f.adapter.publish(f.projection);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("rejects old key/controller, frozen, failed and absent leases", async () => {
    const f = fixture();
    for (const patch of [
      { key: "replacement" },
      { controller: createPanelViewState() },
      { moving: true },
      { failed: true },
      { lease: undefined },
    ]) {
      useWindowViews.setState({
        entries: new Map([[f.record.panelId, { ...f.record, ...patch }]]),
      });
      await expect(f.adapter.call("reset")).rejects.toThrow("staleOwner");
    }
    expect(f.action).not.toHaveBeenCalled();
  });
  it("privately flushes the password before a sanitized save and rechecks the exact owner", async () => {
    const f = fixture();
    const edit = { profile: { id: "proxy" }, credential: { action: "save" } } as Parameters<
      typeof f.adapter.call<"network_saveProfile">
    >[1];
    await f.adapter.call("network_saveProfile", edit);
    expect(f.control).toHaveBeenCalledWith({
      action: "writeSettingsPassword",
      lease: f.record.lease,
      value: "private-password",
    });
    expect(JSON.stringify(f.action.mock.calls)).not.toContain("private-password");
    expect(f.control.mock.invocationCallOrder[0]).toBeLessThan(
      f.action.mock.invocationCallOrder[0]!,
    );
    f.action.mockClear();
    f.control.mockImplementationOnce(async () => {
      useWindowViews.setState({
        entries: new Map([[f.record.panelId, { ...f.record, moving: true }]]),
      });
      return null;
    });
    await expect(f.adapter.call("network_saveProfile", edit)).rejects.toThrow("staleOwner");
    expect(f.action).not.toHaveBeenCalled();
  });
});
