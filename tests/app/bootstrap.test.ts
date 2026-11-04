import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabRecord } from "@/lib/api/types";

const mocks = vi.hoisted(() => ({
  mainWindowSnapshot: vi.fn(),
  tabs: vi.fn(),
  saveTabs: vi.fn(),
  hostLoad: vi.fn(),
  sshRefresh: vi.fn(),
  toast: vi.fn(),
  settingsLoad: vi.fn(),
  settings: { theme: "dark", motion: "system", restoreWorkspace: true },
  updateRefresh: vi.fn(),
  securityLoad: vi.fn(),
  pluginLoad: vi.fn(),
  pluginStart: vi.fn(),
  transferHydrate: vi.fn(async () => {}),
  hosts: [] as { id: string }[],
  events: {
    onSettingsChanged: vi.fn(),
    onUpdateState: vi.fn(),
    onNavigate: vi.fn(),
    onPluginState: vi.fn(),
    onPluginSecurity: vi.fn(),
    onTransfer: vi.fn(),
    onTransfersChanged: vi.fn(),
    onSshClosed: vi.fn(),
  },
}));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, events: mocks.events, isTauri: () => true }));
vi.mock("@/app/backgroundTaskSources", () => ({ registerBackgroundTaskSources: () => () => {} }));
vi.mock("@/app/pluginWorkspaceBridge", () => ({
  wirePluginWorkspaceBridge: vi.fn(async () => vi.fn()),
  reconcilePluginWorkspace: vi.fn(async () => {}),
}));
vi.mock("@/store/hosts", () => ({
  useHosts: { getState: () => ({ load: mocks.hostLoad, hosts: mocks.hosts }) },
}));
vi.mock("@/store/ssh", () => ({
  useSsh: { getState: () => ({ refresh: mocks.sshRefresh, sessions: [], forget: vi.fn() }) },
}));
vi.mock("@/store/settings", () => ({
  useSettings: {
    getState: () => ({
      load: mocks.settingsLoad,
      settings: mocks.settings,
      applyRemote: vi.fn(),
    }),
  },
}));
vi.mock("@/store/updates", () => ({
  useUpdates: { getState: () => ({ refresh: mocks.updateRefresh, apply: vi.fn() }) },
}));
vi.mock("@/store/monitor", () => ({ useMonitor: { getState: () => ({ forget: vi.fn() }) } }));
vi.mock("@/store/plugins", () => ({
  usePlugins: {
    getState: () => ({ apply: vi.fn(), load: mocks.pluginLoad, start: mocks.pluginStart }),
  },
}));
vi.mock("@/store/pluginSecurity", () => ({
  reportPluginExecutionFailure: vi.fn(),
  usePluginSecurity: {
    getState: () => ({ load: mocks.securityLoad, apply: vi.fn(), reportFailure: vi.fn() }),
  },
}));
vi.mock("@/store/transfers", () => ({
  useTransfers: { getState: () => ({ apply: vi.fn(), hydrate: mocks.transferHydrate }) },
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/errors", () => ({ translateError: (error: unknown) => String(error) }));
vi.mock("@/i18n/i18n", () => ({ default: { t: (key: string) => key } }));

const record = (id = "page:about", hostId: string | null = null): TabRecord => ({
  id,
  kind: hostId ? "host" : "about",
  title: id,
  hostId,
  pinned: false,
  sortOrder: 0,
  state: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fresh = async () => {
  const { useWorkspace } = await import("@/store/workspace");
  const { bootstrap } = await import("@/app/bootstrap");
  const { disposeBootstrap } = await import("@/app/bootstrap");
  return { useWorkspace, bootstrap, disposeBootstrap };
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(window.matchMedia).mockReturnValue({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  vi.useFakeTimers();
  mocks.tabs.mockReset().mockResolvedValue([record()]);
  mocks.mainWindowSnapshot.mockReset().mockResolvedValue(null);
  mocks.saveTabs.mockReset().mockResolvedValue(undefined);
  mocks.hostLoad.mockReset().mockResolvedValue(true);
  mocks.sshRefresh.mockReset().mockResolvedValue(undefined);
  mocks.settingsLoad.mockReset().mockResolvedValue(undefined);
  mocks.updateRefresh.mockReset().mockResolvedValue(undefined);
  mocks.securityLoad.mockReset().mockResolvedValue(undefined);
  mocks.pluginLoad.mockReset().mockResolvedValue(undefined);
  mocks.pluginStart.mockReset();
  mocks.toast.mockReset();
  mocks.hosts = [];
  mocks.settings = { theme: "dark", motion: "system", restoreWorkspace: true };
  Object.values(mocks.events).forEach((mock) => mock.mockReset().mockResolvedValue(vi.fn()));
});
afterEach(async () => {
  const { disposeBootstrap } = await import("@/app/bootstrap");
  disposeBootstrap();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("workspace startup and persistence", () => {
  it("does not delay first presentation for background update status", async () => {
    const update = deferred<void>();
    mocks.updateRefresh.mockReturnValueOnce(update.promise);
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(mocks.updateRefresh).toHaveBeenCalledOnce();
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:about"]);
    update.resolve();
  });

  it("discovers plugin contributions before restoring tabs without starting executable plugins", async () => {
    const discovered = deferred<void>();
    mocks.pluginLoad.mockReturnValueOnce(discovered.promise);
    mocks.tabs.mockResolvedValue([{ ...record("sidebar:plugin:assistant:chat"), kind: "sidebar" }]);
    const { bootstrap, useWorkspace } = await fresh();
    const startup = bootstrap();
    await vi.waitFor(() => expect(mocks.pluginLoad).toHaveBeenCalledOnce());
    expect(mocks.tabs).not.toHaveBeenCalled();
    discovered.resolve();
    await startup;
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toContain(
      "sidebar:plugin:assistant:chat",
    );
    expect(mocks.pluginStart).not.toHaveBeenCalled();
  });

  it("skips restoring on the next startup without immediately replacing the saved snapshot", async () => {
    mocks.settings.restoreWorkspace = false;
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    await vi.advanceTimersByTimeAsync(800);
    expect(mocks.saveTabs).not.toHaveBeenCalled();
    useWorkspace.getState().openPage("settings");
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.saveTabs).toHaveBeenCalledTimes(1);
  });

  it("does not close a current workspace when restore is disabled after startup", async () => {
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    mocks.settings.restoreWorkspace = false;
    expect(useWorkspace.getState().tabs[0]?.id).toBe("page:about");
  });

  it("restores pages while leaving saved SSH sessions disconnected", async () => {
    mocks.tabs.mockResolvedValue([
      record(),
      { ...record("terminal:old"), kind: "terminal" },
      { ...record("sftp:old"), kind: "sftp" },
    ]);
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toEqual(["about"]);
    expect(mocks.sshRefresh).toHaveBeenCalledTimes(1);
  });
  it("retains restored host tabs when the host snapshot cannot be loaded", async () => {
    mocks.tabs.mockResolvedValue([record("host:one", "one")]);
    mocks.hostLoad.mockResolvedValue(false);
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["host:one"]);
  });

  it("prunes missing hosts only after a successful host snapshot", async () => {
    mocks.tabs.mockResolvedValue([record("host:one", "one")]);
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.saveTabs).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "page:welcome" }),
    ]);
  });

  it("continues restoration when one event registration fails", async () => {
    mocks.events.onSettingsChanged.mockRejectedValue(new Error("listener failed"));
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(useWorkspace.getState().tabs[0]?.id).toBe("page:about");
    expect(mocks.events.onSshClosed).toHaveBeenCalledTimes(1);
    expect(mocks.hostLoad).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed listener and refreshes its snapshot without duplicating healthy listeners", async () => {
    mocks.events.onSettingsChanged.mockRejectedValueOnce(new Error("listener failed"));
    const { bootstrap } = await fresh();
    await bootstrap();
    expect(mocks.settingsLoad).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.events.onSettingsChanged).toHaveBeenCalledTimes(2);
    expect(mocks.settingsLoad).toHaveBeenCalledTimes(2);
    expect(mocks.events.onSshClosed).toHaveBeenCalledOnce();
    expect(mocks.events.onNavigate).toHaveBeenCalledOnce();
  });

  it("registers listeners before reading settings and releases every view subscription", async () => {
    const cleanups = Object.values(mocks.events).map((registration) => {
      const stop = vi.fn();
      registration.mockResolvedValue(stop);
      return stop;
    });
    const { bootstrap, disposeBootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(mocks.events.onSettingsChanged.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.settingsLoad.mock.invocationCallOrder[0]!,
    );
    disposeBootstrap();
    expect(cleanups.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    const saved = mocks.saveTabs.mock.calls.length;
    useWorkspace.getState().openPage("settings");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.saveTabs).toHaveBeenCalledTimes(saved);
  });

  it("does not restore a disposed startup over a newer workspace", async () => {
    const old = deferred<TabRecord[]>();
    mocks.tabs.mockReturnValueOnce(old.promise).mockResolvedValueOnce([record("page:settings")]);
    const { bootstrap, disposeBootstrap, useWorkspace } = await fresh();
    const starting = bootstrap();
    await vi.waitFor(() => expect(mocks.tabs).toHaveBeenCalledOnce());
    disposeBootstrap();
    await bootstrap();
    old.resolve([record()]);
    await starting;
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:settings"]);
    expect(mocks.events.onNavigate).toHaveBeenCalledTimes(2);
  });

  it("does not write a fallback workspace over a failed snapshot read", async () => {
    mocks.tabs.mockRejectedValue(new Error("database unavailable"));
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    expect(useWorkspace.getState().tabs[0]?.id).toBe("page:welcome");
    await vi.advanceTimersByTimeAsync(800);
    expect(mocks.saveTabs).not.toHaveBeenCalled();
    useWorkspace.getState().openPage("settings");
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.saveTabs).toHaveBeenCalledTimes(1);
  });

  it("serializes saves and coalesces intermediate layouts while a save is pending", async () => {
    const first = deferred<void>();
    mocks.saveTabs.mockReturnValueOnce(first.promise);
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    await vi.advanceTimersByTimeAsync(400);
    useWorkspace.getState().openPage("settings");
    await vi.advanceTimersByTimeAsync(400);
    useWorkspace.getState().openPage("updates");
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.saveTabs).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.resolve();
    expect(mocks.saveTabs).toHaveBeenCalledTimes(2);
    expect((mocks.saveTabs.mock.calls[1]![0] as TabRecord[]).map((tab) => tab.id)).toEqual([
      "page:about",
      "page:settings",
    ]);
  });

  it("continues saving after an earlier persistence failure", async () => {
    mocks.saveTabs.mockRejectedValueOnce(new Error("write failed"));
    const { bootstrap, useWorkspace } = await fresh();
    await bootstrap();
    await vi.advanceTimersByTimeAsync(400);
    useWorkspace.getState().openPage("settings");
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.saveTabs).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("write failed"), "error");
  });

  it("shares a single startup operation and preserves tabs opened during a slow read", async () => {
    const read = deferred<TabRecord[]>();
    mocks.tabs.mockReturnValue(read.promise);
    const { bootstrap, useWorkspace } = await fresh();
    const first = bootstrap();
    expect(bootstrap()).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    useWorkspace.getState().openPage("settings");
    read.resolve([record()]);
    await first;
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:settings"]);
    expect(mocks.tabs).toHaveBeenCalledTimes(1);
  });
});
