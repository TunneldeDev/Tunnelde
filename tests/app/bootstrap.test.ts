// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabRecord } from "@/lib/api/types";

const mocks = vi.hoisted(() => ({
  tabs: vi.fn(),
  saveTabs: vi.fn(),
  hostLoad: vi.fn(),
  sshRefresh: vi.fn(),
  toast: vi.fn(),
  settingsLoad: vi.fn(),
  updateRefresh: vi.fn(),
  hosts: [] as { id: string }[],
  events: {
    onSettingsChanged: vi.fn(),
    onUpdateState: vi.fn(),
    onNavigate: vi.fn(),
    onPluginState: vi.fn(),
    onTransfer: vi.fn(),
    onSshClosed: vi.fn(),
  },
}));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, events: mocks.events, isTauri: () => true }));
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
      settings: { theme: "dark" },
      applyRemote: vi.fn(),
    }),
  },
}));
vi.mock("@/store/updates", () => ({
  useUpdates: { getState: () => ({ refresh: mocks.updateRefresh, apply: vi.fn() }) },
}));
vi.mock("@/store/monitor", () => ({ useMonitor: { getState: () => ({ forget: vi.fn() }) } }));
vi.mock("@/store/plugins", () => ({ usePlugins: { getState: () => ({ apply: vi.fn() }) } }));
vi.mock("@/store/transfers", () => ({ useTransfers: { getState: () => ({ apply: vi.fn() }) } }));
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
  return { useWorkspace, bootstrap };
};

beforeEach(() => {
  vi.resetModules();
  vi.mocked(window.matchMedia).mockReturnValue({
    addEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  vi.useFakeTimers();
  mocks.tabs.mockReset().mockResolvedValue([record()]);
  mocks.saveTabs.mockReset().mockResolvedValue(undefined);
  mocks.hostLoad.mockReset().mockResolvedValue(true);
  mocks.sshRefresh.mockReset().mockResolvedValue(undefined);
  mocks.settingsLoad.mockReset().mockResolvedValue(undefined);
  mocks.updateRefresh.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  mocks.hosts = [];
  Object.values(mocks.events).forEach((mock) => mock.mockReset().mockResolvedValue(vi.fn()));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("workspace startup and persistence", () => {
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
      "page:updates",
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
