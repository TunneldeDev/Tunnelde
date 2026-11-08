import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nativeEvents } from "@/lib/events/native";
import { usePluginTabBar, wireTabBarContributions } from "@/store/tabBar";
import type { TabBarSnapshot } from "@/lib/plugins/tabBar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/events/native", () => ({ nativeEvents: { on: vi.fn() } }));
const handlers = new Map<string, (value: unknown) => void>();
const snapshot = (revision: number): TabBarSnapshot => ({ revision, items: [] });
beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  usePluginTabBar.setState({ revision: -1, items: [] });
  vi.mocked(nativeEvents.on).mockImplementation(async (name, receive) => {
    handlers.set(name, receive as (value: unknown) => void);
    return () => {
      handlers.delete(name);
    };
  });
});

it("subscribes before its snapshot and ignores delayed snapshots and events", async () => {
  let complete!: (value: TabBarSnapshot) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve as typeof complete;
      }),
  );
  const controller = new AbortController();
  const wiring = wireTabBarContributions(controller.signal);
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  handlers.get("plugin://tab-bar-changed")?.(snapshot(4));
  complete(snapshot(1));
  await wiring;
  handlers.get("plugin://tab-bar-changed")?.(snapshot(3));
  expect(usePluginTabBar.getState().revision).toBe(4);
  controller.abort();
  expect(handlers.size).toBe(0);
});

it("restores contributions from the host after remount and refreshes security changes", async () => {
  vi.mocked(invoke).mockResolvedValue(snapshot(6));
  const controller = new AbortController();
  const dispose = await wireTabBarContributions(controller.signal);
  expect(usePluginTabBar.getState().revision).toBe(6);
  handlers.get("plugin:security-changed")?.({});
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  dispose();
  expect(handlers.size).toBe(0);
});

it("does not publish an in-flight response after disposal", async () => {
  let complete!: (value: TabBarSnapshot) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve as typeof complete;
      }),
  );
  const controller = new AbortController();
  const wiring = wireTabBarContributions(controller.signal);
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  controller.abort();
  complete(snapshot(8));
  await wiring;
  expect(usePluginTabBar.getState().revision).toBe(-1);
  expect(handlers.size).toBe(0);
});
