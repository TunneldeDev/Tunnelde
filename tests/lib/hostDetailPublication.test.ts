import "@/i18n/i18n";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { startHostDetailPublication } from "@/features/hosts/detail/publication";
import { hostDetailIds, useHostDetailRegistrations } from "@/features/hosts/detail/registration";
import { useWorkspace } from "@/store/workspace";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { usePanelWindows } from "@/store/panelWindows";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { Host } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { HostDetailModel } from "@/features/hosts/detail/model";
const fixture = vi.hoisted(() => ({ retains: 0, releases: 0 }));
vi.mock("@/features/forwarding/data/readSource", () => ({
  createForwardingReadSource() {
    const data = {
      hosts: [{ id: "a" }, { id: "b" }],
      hostsLoading: false,
      sessions: [
        { id: "s-a", hostId: "a" },
        { id: "s-b", hostId: "b" },
      ],
      rules: {
        entries: [
          { id: "r-a", hostId: "a" },
          { id: "r-b", hostId: "b" },
        ],
        busy: false,
        error: null,
      },
      groups: {
        entries: [
          { id: "g-a", hostId: "a" },
          { id: "g-b", hostId: "b" },
        ],
        busy: false,
        error: null,
      },
    };
    const store = createStore(() => data);
    return {
      store,
      snapshot: () => data,
      retain() {
        fixture.retains++;
        store.setState({ ...data });
        return () => {
          fixture.releases++;
        };
      },
      dispose: vi.fn(),
    };
  },
}));
const h = (id: string): Host => ({
  id,
  name: id,
  host: id + ".invalid",
  port: 22,
  username: "dev",
  authMethod: "password",
  keyPath: null,
  groupId: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
});
const initial = {
  w: useWorkspace.getState(),
  h: useHosts.getState(),
  s: useSettings.getState(),
  p: usePlugins.getState(),
  panels: usePanelWindows.getState(),
};
beforeEach(() => {
  fixture.retains = 0;
  fixture.releases = 0;
  useWorkspace.setState({ ...initial.w, tabs: [], panes: [] });
  useHosts.setState({
    ...initial.h,
    hosts: [
      {
        ...h("a"),
        password: "DO-NOT-TRANSPORT",
        connectionRoute: { secret: "DO-NOT-TRANSPORT" },
      } as Host,
      h("b"),
    ],
  });
  usePlugins.setState({ items: [] });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  useHostDetailRegistrations.setState({ entries: new Map() });
  usePanelWindows.setState({
    windowId: "main",
    snapshot: { windows: [], panels: [], transfers: [] },
  });
});
afterEach(() => {
  useWorkspace.setState(initial.w);
  useHosts.setState(initial.h);
  useSettings.setState(initial.s);
  usePlugins.setState(initial.p);
  usePanelWindows.setState(initial.panels);
  useHostDetailRegistrations.setState({ entries: new Map() });
});
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it("publishes only this host and its forwarding metadata, deduplicates and releases the shared reader", async () => {
  useWorkspace.getState().openHost(h("a"));
  const [id] = hostDetailIds();
  usePanelWindows.setState({
    snapshot: {
      windows: [],
      panels: [],
      transfers: [],
      hostPages: [{ panelId: id!, allowMove: true }],
    },
  });
  const models: HostDetailModel[] = [];
  const control = vi.fn(async (command: { action: string; model?: HostDetailModel }) => {
    if (command.action === "publishModel") models.push(command.model!);
    return "publisher";
  });
  const failure = vi.fn();
  const publication = startHostDetailPublication(
    { control } as unknown as PanelWindowClient,
    () => ({ appearance: DEFAULT_SETTINGS, language: "en-US", platform: "macos" }),
    failure,
  );
  await drain();
  expect(failure).not.toHaveBeenCalled();
  expect(fixture.retains).toBe(1);
  expect(models).toHaveLength(1);
  expect(JSON.stringify(models)).not.toContain("DO-NOT-TRANSPORT");
  expect(models[0]!.detail.host?.id).toBe("a");
  expect(models[0]!.detail.forwarding.rules.entries).toEqual([{ id: "r-a", hostId: "a" }]);
  expect(models[0]!.detail.forwarding.groups.entries).toEqual([{ id: "g-a", hostId: "a" }]);
  expect(models[0]!.detail.forwarding.sessions).toEqual([{ id: "s-a", hostId: "a" }]);
  publication.refresh();
  await drain();
  expect(models).toHaveLength(1);
  useHosts.setState({ hosts: [h("b")] });
  await drain();
  expect(models.at(-1)!.detail.host).toBeNull();
  expect(models.at(-1)!.detail.target).toBeNull();
  useWorkspace.setState({ tabs: [] });
  hostDetailIds();
  await drain();
  expect(fixture.releases).toBe(1);
  publication.dispose();
  expect(fixture.releases).toBe(1);
});
