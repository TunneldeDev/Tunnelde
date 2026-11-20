import { expect, it, vi } from "vitest";
import { createPanelViewState } from "@/lib/panels/viewState";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { createWindowForwardingOwner } from "@/features/forwarding/runtime/windowOwner";
const lease = { panelId: "forwarding", windowId: "satellite", generation: 7 };
function fixture(staged = true) {
  let record: WindowViewRecord | undefined = {
    key: "offer",
    panelId: "forwarding",
    controller: createPanelViewState(),
    staged,
    ...(!staged ? { lease } : {}),
  };
  let frozen = false;
  const mutation = vi.fn(async () => ({ id: "saved" }));
  const refresh = vi.fn();
  const client = {
    windowId: "satellite",
    forwardingMutation: mutation,
  } as unknown as PanelWindowClient;
  const binding = createWindowForwardingOwner(client, record, {
    current: () => record,
    frozen: () => frozen,
    refresh,
    report: vi.fn(),
  });
  return {
    binding,
    mutation,
    refresh,
    get: () => record!,
    set: (value: WindowViewRecord | undefined) => {
      record = value;
    },
    freeze: (value: boolean) => {
      frozen = value;
    },
  };
}
it("creates no transport effects in render; staged reads promote to a fresh exact service without replacing the display owner", async () => {
  const f = fixture();
  expect(f.mutation).not.toHaveBeenCalled();
  const stopStaged = f.binding.start();
  const owner = f.binding.owner;
  expect(owner.target()).toEqual({ kind: "staged", id: "offer" });
  owner.check(false);
  expect(() => owner.check(true)).toThrow("staleOwner");
  expect(f.binding.snapshot()).toBeNull();
  f.set({ ...f.get(), staged: false, lease });
  stopStaged();
  const stop = f.binding.start(lease);
  expect(f.binding.owner).toBe(owner);
  expect(owner.target()).toEqual({ kind: "owned", lease });
  await f.binding.snapshot()!.service.actions.saveGroup("host", "Group");
  expect(f.mutation).toHaveBeenCalledExactlyOnceWith(lease, {
    operation: "saveGroup",
    hostId: "host",
    name: "Group",
  });
  stop();
});
it("freezes captured operations during transfer, interruption or replaced ownership before an effect can run", async () => {
  const f = fixture(false);
  const stop = f.binding.start(lease);
  const actions = f.binding.snapshot()!.service.actions;
  f.freeze(true);
  await expect(actions.saveGroup("host", "Group")).rejects.toThrow("staleOwner");
  f.binding.owner.check(false);
  f.freeze(false);
  f.set({ ...f.get(), moving: true });
  await expect(actions.saveGroup("host", "Group")).rejects.toThrow("staleOwner");
  f.set({ ...f.get(), moving: false, lease: { ...lease, generation: 8 } });
  await expect(actions.saveGroup("host", "Group")).rejects.toThrow("staleOwner");
  expect(f.mutation).not.toHaveBeenCalled();
  stop();
});
it("retires old service callbacks but never lets their late cleanup dispose a replacement", async () => {
  const f = fixture(false);
  const stopFirst = f.binding.start(lease);
  const first = f.binding.snapshot()!;
  f.set({ ...f.get(), lease: { ...lease, generation: 8 } });
  const stopSecond = f.binding.start(f.get().lease);
  const second = f.binding.snapshot()!;
  stopFirst();
  expect(f.binding.snapshot()).toBe(second);
  await expect(first.service.actions.saveGroup("host", "Old")).rejects.toThrow("disposed");
  await second.service.actions.saveGroup("host", "New");
  expect(f.mutation).toHaveBeenCalledOnce();
  stopSecond();
  expect(f.binding.snapshot()).toBeNull();
  await expect(second.service.actions.saveGroup("host", "Late")).rejects.toThrow("disposed");
});
it("rejects another record/controller/failed panel and invalid lease ownership", () => {
  const f = fixture(false);
  const stop = f.binding.start(lease);
  const original = f.get();
  for (const next of [
    { ...original, key: "other" },
    { ...original, controller: createPanelViewState() },
    { ...original, failed: true },
    undefined,
  ]) {
    f.set(next);
    expect(() => f.binding.owner.target()).toThrow("staleOwner");
    expect(() => f.binding.owner.check(false)).toThrow("staleOwner");
  }
  f.set({ ...original, lease: { ...lease, windowId: "foreign" } });
  expect(() => f.binding.owner.target()).toThrow("staleOwner");
  expect(() => f.binding.start(f.get().lease)).toThrow("staleOwner");
  stop();
});
it("supports StrictMode stop/restart with independent subscriptions and no acquired effects", () => {
  const f = fixture(false),
    notified = vi.fn();
  const unsubscribe = f.binding.subscribe(notified);
  const first = f.binding.start(lease);
  first();
  const second = f.binding.start(lease);
  expect(f.binding.snapshot()).toBeTruthy();
  second();
  unsubscribe();
  expect(notified).toHaveBeenCalledTimes(4);
  f.binding.start()();
  expect(notified).toHaveBeenCalledTimes(4);
  expect(f.mutation).not.toHaveBeenCalled();
});

it("cannot treat another builtin panel as a forwarding owner", () => {
  const f = fixture(false);
  expect(() =>
    createWindowForwardingOwner(
      { windowId: "satellite" } as PanelWindowClient,
      { ...f.get(), panelId: "output" },
      { current: f.get, frozen: () => false, refresh: vi.fn(), report: vi.fn() },
    ),
  ).toThrow("unsupportedView");
});
