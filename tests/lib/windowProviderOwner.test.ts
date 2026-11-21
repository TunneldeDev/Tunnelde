import { expect, it } from "vitest";
import { createWindowProviderOwner } from "@/lib/panels/windowProviderOwner";
import { createPanelViewState } from "@/lib/panels/viewState";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";

it("keeps staged display identity but allows actions only for an effect-committed exact lease", () => {
  const controller = createPanelViewState();
  const initial: WindowViewRecord = { key: "offer", panelId: "tasks", controller, staged: true };
  let current: WindowViewRecord | undefined = initial,
    frozen = false;
  const binding = createWindowProviderOwner(
    { windowId: "satellite" } as PanelWindowClient,
    initial,
    { current: () => current, frozen: () => frozen },
  );
  const stopStage = binding.start();
  expect(binding.owner.target()).toEqual({ kind: "staged", id: "offer" });
  expect(() => binding.owner.check(false)).not.toThrow();
  expect(() => binding.owner.check(true)).toThrow();
  const lease = { panelId: "tasks", windowId: "satellite", generation: 2 };
  current = { ...initial, staged: false, lease };
  expect(() => binding.owner.check(true)).toThrow();
  const stop = binding.start(lease);
  stopStage();
  expect(() => binding.owner.check(true)).not.toThrow();
  frozen = true;
  expect(() => binding.owner.check(true)).toThrow();
  frozen = false;
  current = { ...current, moving: true };
  expect(() => binding.owner.check(true)).toThrow();
  current = { ...current, moving: false, lease: { ...lease, generation: 3 } };
  expect(() => binding.owner.check(true)).toThrow();
  current = { ...current, lease };
  expect(() => binding.owner.check(true)).not.toThrow();
  stop();
  expect(() => binding.owner.check(true)).toThrow();
  controller.dispose();
});
it("retained owners cannot be revived by replacement records or documents", () => {
  const controller = createPanelViewState();
  const lease = { panelId: "tasks", windowId: "satellite", generation: 2 };
  const initial: WindowViewRecord = {
    key: "tasks",
    panelId: "tasks",
    controller,
    staged: false,
    lease,
  };
  let current: WindowViewRecord | undefined = initial;
  const binding = createWindowProviderOwner(
    { windowId: "satellite" } as PanelWindowClient,
    initial,
    { current: () => current, frozen: () => false },
  );
  const stop = binding.start(lease);
  const replacement = createPanelViewState();
  for (const next of [
    undefined,
    { ...initial, controller: replacement },
    { ...initial, key: "replacement" },
    { ...initial, failed: true },
  ]) {
    current = next;
    expect(() => binding.owner.check(false)).toThrow();
    expect(() => binding.owner.check(true)).toThrow();
    expect(() => binding.owner.target()).toThrow();
  }
  current = { ...initial, lease: { ...lease, windowId: "other" } };
  expect(() => binding.owner.target()).toThrow();
  expect(() => binding.start({ ...lease, panelId: "other" })).toThrow();
  stop();
  controller.dispose();
  replacement.dispose();
});
