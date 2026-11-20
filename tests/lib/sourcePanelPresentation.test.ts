import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { FloatingPanelState } from "@/store/panelPresentation";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import {
  installSourcePanelPresentation,
  sourcePanelPresentation,
  startSourcePanelFocus,
} from "@/lib/panels/sourcePresentation";
import { createLocalPanelPresentation } from "@/lib/panels/localPresentation";
import { createLocalPanelWorkspace } from "@/lib/panels/localWorkspace";
import { useWindowViews } from "@/lib/panels/windowViews";
import { createPanelViewState } from "@/lib/panels/viewState";
const stops: (() => void)[] = [];
beforeEach(() => useWindowViews.setState({ entries: new Map() }));
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
  useWindowViews.setState({ entries: new Map() });
});
const slot = () =>
  createStore<FloatingPanelState>(
    () =>
      ({
        pinned: true,
        bounds: null,
      }) as FloatingPanelState,
  );
function fixture() {
  const workspace = createLocalPanelWorkspace();
  workspace.reconcile(["tasks", "connections"]);
  const slots = new Map([
    ["tasks", slot()],
    ["connections", slot()],
  ]);
  const host = createLocalPanelPresentation("satellite", workspace, () => slots);
  return { workspace, slots, host };
}
it("has one exact document adapter whose stale disposer cannot remove a replacement", () => {
  const a = fixture().host,
    b = fixture().host;
  const stop = installSourcePanelPresentation(a);
  stops.push(stop);
  expect(sourcePanelPresentation()).toBe(a);
  expect(() => installSourcePanelPresentation(b)).toThrow("alreadyInstalled");
  stop();
  stops.push(installSourcePanelPresentation(b));
  stop();
  expect(sourcePanelPresentation()).toBe(b);
});
it("reads closed local layout metadata, clones geometry and rejects nonexistent/unsupported presentations", () => {
  const f = fixture();
  const bounds = { x: 3, y: 4, width: 400, height: 300 };
  f.slots.get("connections")!.setState({ bounds, pinned: false });
  expect(f.host.read().find((p) => p.id === "connections")).toEqual({
    id: "connections",
    windowId: "satellite",
    presentation: "workspace",
    visible: true,
    available: true,
    pinned: false,
    bounds,
    presentations: ["workspace", "floating"],
  });
  f.host.read().find((p) => p.id === "connections")!.bounds!.x = 99;
  expect(bounds.x).toBe(3);
  const previous = f.workspace.store.getState();
  expect(() => f.host.set("connections", "sidebar")).toThrow("unsupportedPresentation");
  expect(f.workspace.store.getState()).toBe(previous);
  expect(() => f.host.close("missing")).toThrow("viewNotReady");
  f.slots.delete("tasks");
  expect(() => f.host.reveal("tasks")).toThrow("viewNotReady");
});
it("hide retains floating/group location and metadata while reveal or set changes only source presentation", () => {
  const f = fixture();
  f.host.set("connections", "floating");
  f.host.close("connections");
  expect(f.host.read().find((p) => p.id === "connections")).toMatchObject({
    visible: false,
    presentation: "floating",
    available: true,
  });
  f.host.reveal("connections");
  expect(f.host.read().find((p) => p.id === "connections")?.visible).toBe(true);
  f.host.set("connections", "workspace");
  f.workspace.split("connections", "row");
  const retained = f.workspace.store.getState();
  f.host.set("connections", "workspace");
  expect(f.workspace.store.getState().layout).toBe(retained.layout);
  expect(
    f.workspace.store.getState().groups.find((g) => g.panels.includes("connections"))?.id,
  ).toBe(retained.groups.find((g) => g.panels.includes("connections"))?.id);
  f.host.close("connections");
  expect(f.host.read().find((p) => p.id === "tasks")?.visible).toBe(true);
  f.host.reveal("connections");
  expect(f.host.read().find((p) => p.id === "connections")?.visible).toBe(true);
});
it("observes newly added floating slots, detaches removed ones and fully releases subscriptions", () => {
  const f = fixture(),
    changed = vi.fn();
  const stop = f.host.subscribe(changed);
  f.slots.get("tasks")!.setState({ pinned: false });
  expect(changed).toHaveBeenCalledTimes(1);
  const added = slot();
  f.slots.set("output", added);
  f.workspace.reconcile(["tasks", "connections", "output"]);
  added.setState({ pinned: false });
  expect(changed).toHaveBeenCalledTimes(3);
  f.slots.delete("output");
  f.workspace.reconcile(["tasks", "connections"]);
  const count = changed.mock.calls.length;
  added.setState({ pinned: true });
  expect(changed).toHaveBeenCalledTimes(count);
  stop();
  stop();
  f.workspace.float("tasks");
  f.slots.get("tasks")!.setState({ pinned: true });
  expect(changed).toHaveBeenCalledTimes(count);
});
it("reveals only the exact current nonstaged owner on native focus and cleans late listeners", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  const lease = { panelId: "connections", windowId: "satellite", generation: 8 };
  const controller = createPanelViewState();
  stops.push(() => controller.dispose());
  const record = { panelId: lease.panelId, key: "v", lease, staged: false, controller };
  useWindowViews.setState({ entries: new Map([[lease.panelId, record]]) });
  let receive!: (lease: PanelLease) => void;
  let settle!: (stop: () => void) => void;
  const unlisten = vi.fn(),
    failure = vi.fn();
  const client = {
    windowId: "satellite",
    onPanelFocus: vi.fn((fn) => {
      receive = fn;
      return new Promise<() => void>((resolve) => {
        settle = resolve;
      });
    }),
  } as unknown as PanelWindowClient;
  f.host.close("connections");
  const stop = startSourcePanelFocus(client, failure);
  stops.push(stop);
  receive({ ...lease, generation: 7 });
  receive({ ...lease, windowId: "other" });
  // The client validates event window identity too; the source validates its
  // current record against both the received lease and its own document.
  expect(f.host.read().find((p) => p.id === "connections")?.visible).toBe(false);
  receive(lease);
  expect(f.host.read().find((p) => p.id === "connections")?.visible).toBe(true);
  useWindowViews.setState({ entries: new Map([[lease.panelId, { ...record, staged: true }]]) });
  f.host.close("connections");
  receive(lease);
  expect(f.host.read().find((p) => p.id === "connections")?.visible).toBe(false);
  stop();
  settle(unlisten);
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledOnce();
  receive(lease);
  expect(failure).not.toHaveBeenCalled();
});
