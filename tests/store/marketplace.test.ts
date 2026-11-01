import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginConfig, PluginDownload, PluginInfo } from "@/lib/api/types";
import type {
  useMarketplace as MarketplaceStore,
  newerVersion as NewerVersion,
} from "@/store/marketplace";
import {
  catalogue,
  community,
  config,
  deferred,
  entry,
  official,
  plugin,
} from "../fixtures/plugins";
const mock = vi.hoisted(() => ({
  api: {
    pluginConfig: vi.fn(),
    marketplaceCatalogue: vi.fn(),
    pluginSourcesSave: vi.fn(),
    downloadCancel: vi.fn(),
  },
  events: { onPluginConfig: vi.fn(), onPluginDownload: vi.fn() },
  install: vi.fn(),
  items: [] as PluginInfo[],
}));
vi.mock("@/lib/api/ipc", () => ({ api: mock.api, events: mock.events, isTauri: () => true }));
vi.mock("@/store/plugins", () => ({
  usePlugins: { getState: () => ({ items: mock.items, installMarket: mock.install }) },
}));
vi.mock("@/lib/api/errors", () => ({
  translateError: (error: { message: string }) => error.message,
}));
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));
let useMarketplace: typeof MarketplaceStore;
let newerVersion: typeof NewerVersion;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mock.items = [];
  mock.api.pluginConfig.mockResolvedValue(config());
  mock.api.marketplaceCatalogue.mockImplementation(async (id: string) =>
    catalogue(id === community.id ? community : official),
  );
  mock.api.pluginSourcesSave.mockImplementation(async (sources) => config(sources));
  mock.api.downloadCancel.mockResolvedValue(undefined);
  mock.events.onPluginConfig.mockResolvedValue(vi.fn());
  mock.events.onPluginDownload.mockResolvedValue(vi.fn());
  mock.install.mockResolvedValue(true);
  ({ useMarketplace, newerVersion } = await import("@/store/marketplace"));
});

describe("marketplace request ownership", () => {
  it("deduplicates concurrent configuration and per-source catalogue requests", async () => {
    mock.api.pluginConfig.mockResolvedValue(config([official, community]));
    const response = deferred<ReturnType<typeof catalogue>>();
    mock.api.marketplaceCatalogue.mockReturnValue(response.promise);
    const first = useMarketplace.getState().load();
    const second = useMarketplace.getState().load();
    await vi.waitFor(() => expect(mock.api.marketplaceCatalogue).toHaveBeenCalledTimes(2));
    expect(mock.api.pluginConfig).toHaveBeenCalledOnce();
    expect(mock.events.onPluginConfig).toHaveBeenCalledOnce();
    expect(mock.events.onPluginDownload).toHaveBeenCalledOnce();
    expect(useMarketplace.getState().loading.sort()).toEqual(["community", "official"]);
    response.resolve(catalogue());
    await Promise.all([first, second]);
    expect(useMarketplace.getState().loading).toEqual([]);
  });

  it("keeps a new source URL loading when the previous URL finishes and discards its response", async () => {
    useMarketplace.setState({ ready: true, config: config([community]) });
    const old = deferred<ReturnType<typeof catalogue>>(),
      current = deferred<ReturnType<typeof catalogue>>();
    mock.api.marketplaceCatalogue
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const load = useMarketplace.getState().load();
    await vi.waitFor(() => expect(mock.api.marketplaceCatalogue).toHaveBeenCalledOnce());
    const edited = { ...community, url: "https://new.example/index.json" };
    const next = config([edited]);
    const onConfig = mock.events.onPluginConfig.mock.calls[0]![0] as (value: PluginConfig) => void;
    onConfig(next);
    await vi.waitFor(() => expect(mock.api.marketplaceCatalogue).toHaveBeenCalledTimes(2));
    old.resolve(catalogue(community));
    await load;
    expect(useMarketplace.getState().catalogues.community).toBeUndefined();
    expect(useMarketplace.getState().loading).toEqual(["community"]);
    current.resolve(catalogue(edited));
    await vi.waitFor(() => expect(useMarketplace.getState().loading).toEqual([]));
    expect(useMarketplace.getState().catalogues.community?.source.url).toBe(edited.url);
  });

  it("preserves a config event that arrives before an older config snapshot", async () => {
    const snapshot = deferred<PluginConfig>();
    mock.api.pluginConfig.mockReturnValue(snapshot.promise);
    const load = useMarketplace.getState().load();
    await vi.waitFor(() => expect(mock.api.pluginConfig).toHaveBeenCalledOnce());
    const changed = config([official, community]);
    (mock.events.onPluginConfig.mock.calls[0]![0] as (value: PluginConfig) => void)(changed);
    snapshot.resolve(config());
    await load;
    await vi.waitFor(() => expect(useMarketplace.getState().loading).toEqual([]));
    expect(useMarketplace.getState().config).toEqual(changed);
  });

  it("retains cached entries when refresh fails and ignores a removed source response", async () => {
    useMarketplace.setState({
      ready: true,
      config: config([community]),
      catalogues: { community: catalogue(community) },
    });
    mock.api.marketplaceCatalogue.mockRejectedValueOnce(new Error("Offline"));
    await useMarketplace.getState().load(true);
    expect(useMarketplace.getState().catalogues.community?.entries).toEqual([entry]);
    expect(useMarketplace.getState().errors.community).toBe("Offline");
    const pending = deferred<ReturnType<typeof catalogue>>();
    mock.api.marketplaceCatalogue.mockReturnValueOnce(pending.promise);
    const old = useMarketplace.getState().load();
    await vi.waitFor(() => expect(mock.api.marketplaceCatalogue).toHaveBeenCalledTimes(2));
    await useMarketplace.getState().saveSources([]);
    pending.resolve(catalogue(community));
    await old;
    expect(useMarketplace.getState().catalogues).toEqual({});
    expect(useMarketplace.getState().loading).toEqual([]);
  });

  it("retries a failed configuration load without leaving disabled controls stuck", async () => {
    mock.api.pluginConfig.mockRejectedValueOnce(new Error("Settings unreadable"));
    await useMarketplace.getState().load();
    expect(useMarketplace.getState().configError).toBe("Settings unreadable");
    expect(useMarketplace.getState().configLoading).toBe(false);
    await useMarketplace.getState().load(true);
    expect(useMarketplace.getState().ready).toBe(true);
    expect(useMarketplace.getState().configError).toBeNull();
  });

  it("registers progress before starting a download and routes events by task ID", async () => {
    useMarketplace.setState({ ready: true, config: config() });
    const listener = deferred<() => void>(),
      installed = deferred<boolean>();
    mock.events.onPluginDownload.mockReturnValue(listener.promise);
    mock.install.mockReturnValue(installed.promise);
    const request = useMarketplace.getState().install(entry, official, false);
    expect(useMarketplace.getState().install(entry, official, false)).toBe(request);
    await vi.waitFor(() => expect(mock.events.onPluginDownload).toHaveBeenCalledOnce());
    expect(mock.install).not.toHaveBeenCalled();
    listener.resolve(vi.fn());
    await vi.waitFor(() => expect(mock.install).toHaveBeenCalledOnce());
    const taskId = useMarketplace.getState().tasks.formatter!.taskId;
    const onProgress = mock.events.onPluginDownload.mock.calls[0]![0] as (
      value: PluginDownload,
    ) => void;
    onProgress({ taskId: "unrelated", phase: "downloading", received: 99, total: 100 });
    expect(useMarketplace.getState().tasks.formatter!.received).toBe(0);
    onProgress({ taskId, phase: "downloading", received: 50, total: 100 });
    expect(useMarketplace.getState().tasks.formatter!.received).toBe(50);
    installed.resolve(true);
    await request;
    onProgress({ taskId, phase: "done", received: 100, total: 100 });
    expect(useMarketplace.getState().tasks).toEqual({});
  });

  it("cancels while listener registration is pending without starting a backend task", async () => {
    const listener = deferred<() => void>();
    mock.events.onPluginDownload.mockReturnValue(listener.promise);
    const request = useMarketplace.getState().install(entry, official, false);
    await useMarketplace.getState().cancel(entry.id);
    listener.resolve(vi.fn());
    await request;
    expect(mock.install).not.toHaveBeenCalled();
    expect(mock.api.downloadCancel).not.toHaveBeenCalled();
    expect(useMarketplace.getState().tasks).toEqual({});
    expect(useMarketplace.getState().cancelling).toEqual([]);
  });

  it("cancels an active task once and exposes cancellation failures without rejecting UI handlers", async () => {
    useMarketplace.setState({ ready: true, config: config() });
    const installed = deferred<boolean>();
    mock.install.mockReturnValue(installed.promise);
    const request = useMarketplace.getState().install(entry, official, false);
    await vi.waitFor(() => expect(mock.install).toHaveBeenCalledOnce());
    mock.api.downloadCancel.mockRejectedValueOnce(new Error("Cancel failed"));
    await useMarketplace.getState().cancel(entry.id);
    expect(useMarketplace.getState().taskErrors.formatter).toBe("Cancel failed");
    expect(useMarketplace.getState().cancelling).toEqual([]);
    await useMarketplace.getState().cancel(entry.id);
    await useMarketplace.getState().cancel(entry.id);
    expect(mock.api.downloadCancel).toHaveBeenCalledTimes(2);
    installed.resolve(false);
    await request;
    expect(useMarketplace.getState().cancelling).toEqual([]);
  });

  it("rejects URL changes and source conflicts between confirmation and download", async () => {
    useMarketplace.setState({ ready: true, config: config([{ ...official, url: community.url }]) });
    await useMarketplace.getState().install(entry, official, false);
    expect(mock.install).not.toHaveBeenCalled();
    expect(useMarketplace.getState().taskErrors.formatter).toBe("market.sourceMismatch");
    useMarketplace.setState({ config: config() });
    mock.items = [{ ...plugin, sourceId: community.id, sourceUrl: community.url }];
    await useMarketplace.getState().install(entry, official, false);
    expect(mock.install).not.toHaveBeenCalled();
    expect(useMarketplace.getState().taskErrors.formatter).toBe("market.sourceConflict");
  });
});

describe("marketplace version ordering", () => {
  it("compares releases and prereleases numerically without treating build metadata as an update", () => {
    expect(newerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(newerVersion("1.0.0-alpha.10", "1.0.0-alpha.2")).toBe(true);
    expect(newerVersion("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(newerVersion("1.0.0-alpha", "1.0.0")).toBe(false);
    expect(newerVersion("1.0.0+build2", "1.0.0+build1")).toBe(false);
    expect(newerVersion("invalid", "1.0.0")).toBe(false);
  });
});
