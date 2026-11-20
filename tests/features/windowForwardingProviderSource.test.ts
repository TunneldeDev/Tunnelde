import { afterEach, expect, it, vi } from "vitest";
import { createWindowForwardingProviderSource } from "@/features/forwarding/runtime/windowProviderSource";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { NativeForwardingProviderDescriptor } from "@/lib/panels/windowProtocol";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function fixture() {
  let descriptor: NativeForwardingProviderDescriptor | null = {
    selectionRevision: 1,
    capabilities: { write: true },
    view: {
      pluginId: "selected",
      runtimeId: "runtime",
      generation: 3,
      viewId: "forwards",
      entry: "index.mjs",
      sdkVersion: "0.1.0",
      title: "Forwarding",
      allowFloating: true,
    },
  };
  let changed: () => void = () => {};
  const unsubscribe = vi.fn();
  const describe = vi.fn(async () => structuredClone(descriptor));
  const subscribe = vi.fn(async (next: () => void): Promise<() => void> => {
    changed = next;
    return unsubscribe;
  });
  const target = {
    kind: "owned" as const,
    lease: { panelId: "forwarding", windowId: "satellite", generation: 7 },
  };
  const check = vi.fn();
  const client = {
    pluginViews: vi.fn(() => ({ describeForwardingProvider: describe })),
    subscribeForwardingProvider: subscribe,
  } as unknown as PanelWindowClient;
  const source = createWindowForwardingProviderSource(
    { client, check, target: () => target },
    "host",
    vi.fn(),
  );
  const start = () => {
    const stop = source.start();
    stops.push(stop);
    return stop;
  };
  return {
    source,
    start,
    describe,
    subscribe,
    check,
    unsubscribe,
    target,
    notify: () => changed(),
    selected: () => descriptor!,
    set: (next: NativeForwardingProviderDescriptor | null) => {
      descriptor = next;
    },
  };
}
it("uses native selection only and preserves one factory through unchanged notifications and ownership promotion", async () => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.source.snapshot().source).toBeTruthy());
  const original = f.source.snapshot().source!;
  // Object key order is transport detail, not a new native provider identity.
  f.set({ view: f.selected().view, capabilities: { write: true }, selectionRevision: 1 });
  f.target.lease.generation = 8;
  f.notify();
  await vi.waitFor(() => expect(f.describe).toHaveBeenCalledTimes(3));
  expect(f.source.snapshot().source).toBe(original);
  original.check(false);
  expect(f.check).toHaveBeenLastCalledWith(false);
});
it("retires exact old callbacks on selection revision ABA, permission changes and explicit deselection", async () => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.source.snapshot().source).toBeTruthy());
  const first = f.source.snapshot().source!;
  f.set({ ...f.selected(), selectionRevision: 3 });
  f.notify();
  await vi.waitFor(() => expect(f.source.snapshot().source).not.toBe(first));
  expect(() => first.check(true)).toThrow("expired");
  const second = f.source.snapshot().source!;
  f.set({ ...f.selected(), capabilities: { write: false } });
  f.notify();
  await vi.waitFor(() => expect(f.source.snapshot().source).not.toBe(second));
  expect(() => second.check(false)).toThrow("expired");
  const third = f.source.snapshot().source!;
  f.set(null);
  f.notify();
  await vi.waitFor(() =>
    expect(f.source.snapshot()).toEqual({ loading: false, source: null, error: null }),
  );
  expect(() => third.check(false)).toThrow("expired");
});
it("retains actual drafts on transient discovery failures and recovers without reattaching", async () => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.source.snapshot().source).toBeTruthy());
  const original = f.source.snapshot().source!;
  f.describe.mockRejectedValueOnce(new Error("temporary metadata failure"));
  f.notify();
  await vi.waitFor(() =>
    expect(String(f.source.snapshot().error)).toContain("temporary metadata failure"),
  );
  expect(f.source.snapshot().source).toBe(original);
  f.notify();
  await vi.waitFor(() => expect(f.source.snapshot().error).toBeNull());
  expect(f.source.snapshot().source).toBe(original);
});
it("coalesces notifications into one in-flight metadata read and one follow-up", async () => {
  const f = fixture();
  let release!: (value: NativeForwardingProviderDescriptor) => void;
  f.describe.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done as never;
      }),
  );
  f.start();
  await vi.waitFor(() => expect(f.describe).toHaveBeenCalledOnce());
  for (let i = 0; i < 50; i++) f.notify();
  expect(f.describe).toHaveBeenCalledOnce();
  release(f.selected());
  await vi.waitFor(() => expect(f.describe).toHaveBeenCalledTimes(2));
  expect(f.source.snapshot().source).toBeTruthy();
});
it("discards late replies and unsubscribes a late observer after stop; restart cannot revive old sources", async () => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.source.snapshot().source).toBeTruthy());
  const first = f.source.snapshot().source!;
  let observed!: (value: () => void) => void;
  f.subscribe.mockImplementationOnce(
    () =>
      new Promise((done) => {
        observed = done;
      }),
  );
  let release!: (value: NativeForwardingProviderDescriptor) => void;
  f.describe.mockImplementationOnce(
    () =>
      new Promise((done) => {
        release = done as never;
      }),
  );
  const stop = f.start();
  stop();
  expect(() => first.check(false)).toThrow("expired");
  const before = f.source.snapshot();
  release(f.selected());
  observed(f.unsubscribe);
  await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(2));
  expect(f.source.snapshot()).toBe(before);
});
it("only an explicit retry replaces an unchanged failed factory identity", async () => {
  const f = fixture();
  f.start();
  await vi.waitFor(() => expect(f.source.snapshot().source).toBeTruthy());
  const first = f.source.snapshot().source!;
  f.source.refresh();
  await vi.waitFor(() => expect(f.source.snapshot().source).not.toBe(first));
  expect(() => first.check(false)).toThrow("expired");
});
