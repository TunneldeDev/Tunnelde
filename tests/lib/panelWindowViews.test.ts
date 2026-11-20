import { afterEach, expect, it, vi } from "vitest";
import { createWindowViews, useWindowViews } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelDomState } from "@/lib/panels/domState";
import type { NativePanelSnapshot, PanelLease } from "@/lib/panels/windowProtocol";

const dom = { version: 1 as const, scroll: { body: { top: 73, left: 0 } }, focus: null };
const state = { version: 1, view: { version: 1, fields: { search: "private draft" } }, dom };
const lease: PanelLease = { panelId: "connections", windowId: "main", generation: 3 };
const snapshot = (
  panels: PanelLease[] = [],
  transfers: NativePanelSnapshot["transfers"] = [],
): NativePanelSnapshot => ({ windows: [], panels, transfers });
const fixtures: ReturnType<typeof createWindowViews>[] = [];
afterEach(() => {
  for (const views of fixtures.splice(0)) views.dispose();
});
function fixture() {
  const client = {
    windowId: "main",
    control: vi.fn(async () => state),
  } as unknown as PanelWindowClient;
  const views = createWindowViews(client);
  fixtures.push(views);
  return { client, views };
}
it("captures explicit fields and DOM only; checkpoint revisions are generation scoped", async () => {
  const { client, views } = fixture();
  await views.reconcile(snapshot([lease]));
  const record = useWindowViews.getState().entries.get("connections")!;
  record.controller.register("search", () => "updated draft");
  views.registerRoot("connections", () => dom);
  expect(views.capture("connections")).toEqual({
    ...state,
    view: { version: 1, fields: { search: "updated draft" } },
  });
  await views.checkpoint("connections");
  await views.checkpoint("connections");
  expect(
    vi
      .mocked(client.control)
      .mock.calls.slice(-2)
      .map(([request]) => request),
  ).toEqual([
    expect.objectContaining({ action: "checkpoint", lease, revision: 1 }),
    expect.objectContaining({ action: "checkpoint", lease, revision: 2 }),
  ]);
  await views.reconcile(snapshot([{ ...lease, generation: 4 }]));
  views.registerRoot("connections", () => dom);
  await views.checkpoint("connections");
  expect(client.control).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
});
it("ack readiness waits for the real rendered tree and commit promotes its existing controller/key", async () => {
  const { views } = fixture();
  const offer = { id: "offer1", lease: { ...lease, windowId: "satellite" }, targetWindow: "main" };
  const controller = new AbortController(),
    done = vi.fn();
  const stage = views.stage(offer, state, controller.signal).then(done);
  const record = useWindowViews.getState().entries.get("connections")!;
  expect(record.staged).toBe(true);
  expect(done).not.toHaveBeenCalled();
  views.rendered(offer.id);
  await stage;
  expect(done).toHaveBeenCalledOnce();
  await views.reconcile(snapshot([{ ...lease, generation: 9 }]));
  const promoted = useWindowViews.getState().entries.get("connections")!;
  expect(promoted.staged).toBe(false);
  expect(promoted.key).toBe(offer.id);
  expect(promoted.controller).toBe(record.controller);
  expect(promoted.controller.read("search", (v): v is string => typeof v === "string")).toBe(
    "private draft",
  );
});
it("cancelled staging erases capsules and does not authorize or capture unfinished views", async () => {
  const { views } = fixture();
  const controller = new AbortController();
  const stage = views.stage(
    { id: "cancelled", lease, targetWindow: "main" },
    state,
    controller.signal,
  );
  const rejected = expect(stage).rejects.toThrow("cancelled");
  const record = useWindowViews.getState().entries.get("connections")!;
  expect(() => views.capture("connections")).toThrow("viewNotReady");
  controller.abort();
  await rejected;
  expect(useWindowViews.getState().entries.size).toBe(0);
  expect(() => record.controller.capture()).toThrow("disposed");
});
it("stale reads cannot resurrect an owner after a newer snapshot/revocation", async () => {
  const { client, views } = fixture();
  let resolve!: (value: unknown) => void;
  vi.mocked(client.control).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const old = views.reconcile(snapshot([lease]));
  await views.reconcile(snapshot());
  resolve(state);
  await old;
  expect(useWindowViews.getState().entries.size).toBe(0);
});
it("rejects unknown adapters or malformed capsules instead of acknowledging an empty shell", async () => {
  const { views } = fixture();
  const signal = new AbortController().signal;
  await expect(
    views.stage(
      { id: "unknown", lease: { ...lease, panelId: "plugin:x:y" }, targetWindow: "main" },
      state,
      signal,
    ),
  ).rejects.toThrow("unsupportedView");
  expect(() =>
    views.stage({ id: "bad", lease, targetWindow: "main" }, { version: 100 }, signal),
  ).toThrow("invalid");
  expect(useWindowViews.getState().entries.size).toBe(0);
});
it("local move freezing does not replace or erase the source view state", async () => {
  const { views } = fixture();
  await views.reconcile(snapshot([lease]));
  const before = useWindowViews.getState().entries.get("connections")!;
  views.setMoving("connections", true);
  const frozen = useWindowViews.getState().entries.get("connections")!;
  expect(frozen.moving).toBe(true);
  expect(frozen.controller).toBe(before.controller);
  views.setMoving("connections", false);
  expect(useWindowViews.getState().entries.get("connections")!.moving).toBe(false);
});

it("retries invalidated async capsules and captures the latest DOM only after plugin work settles", async () => {
  const { views } = fixture();
  await views.reconcile(snapshot([lease]));
  const record = useWindowViews.getState().entries.get("connections")!;
  let finish!: (value: unknown) => void;
  const capture = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("new");
  record.controller.registerAsync("draft", capture);
  const root = vi.fn(() => dom);
  views.registerRoot("connections", root);
  const pending = views.captureAsync("connections");
  record.controller.changed();
  finish("stale");
  expect((await pending).view.fields).toEqual({ draft: "new" });
  expect(capture).toHaveBeenCalledTimes(2);
  expect(root).toHaveBeenCalledOnce();
});
it("rejects an async capture whose root has been replaced even when the lease generation matches", async () => {
  const { views } = fixture();
  await views.reconcile(snapshot([lease]));
  const record = useWindowViews.getState().entries.get("connections")!;
  let finish!: (value: unknown) => void;
  record.controller.registerAsync(
    "draft",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  views.registerRoot("connections", () => dom);
  const check = expect(views.captureAsync("connections")).rejects.toThrow("staleOwner");
  views.registerRoot("connections", () => dom);
  finish("late");
  await check;
});
it("cannot publish an async checkpoint after its owner is removed or replaced", async () => {
  const { views, client } = fixture();
  await views.reconcile(snapshot([lease]));
  const record = useWindowViews.getState().entries.get("connections")!;
  let finish!: (value: unknown) => void;
  record.controller.registerAsync(
    "draft",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  views.registerRoot("connections", () => dom);
  const check = expect(views.checkpoint("connections")).rejects.toThrow();
  await views.reconcile(snapshot([{ ...lease, generation: 9 }]));
  finish("late");
  await check;
  expect(client.control).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "checkpoint" }),
  );
});
it("stage render failure or document disposal rejects readiness, never acknowledges an empty shell", async () => {
  const { views } = fixture();
  const stage = views.stage(
    { id: "broken", lease, targetWindow: "main" },
    state,
    new AbortController().signal,
  );
  const check = expect(stage).rejects.toThrow("view failure");
  views.renderFailed("broken", new Error("view failure"));
  await check;
  expect(useWindowViews.getState().entries.size).toBe(0);
  const next = views.stage(
    { id: "disposed", lease, targetWindow: "main" },
    state,
    new AbortController().signal,
  );
  const disposed = expect(next).rejects.toThrow("disposed");
  views.dispose();
  await disposed;
});
it("old cleanup cannot unfreeze the replacement lease generation", async () => {
  const { views } = fixture();
  await views.reconcile(snapshot([lease]));
  await views.reconcile(snapshot([{ ...lease, generation: 9 }]));
  views.setMoving("connections", true);
  views.setMoving("connections", false, lease);
  expect(useWindowViews.getState().entries.get("connections")!.moving).toBe(true);
});

it.each([undefined, null, false, 0, ""])(
  "falsy renderer rejection is still a failed stage, never an ACK",
  async (error) => {
    const { views } = fixture();
    const pending = views.stage(
      { id: "falsy", lease, targetWindow: "main" },
      state,
      new AbortController().signal,
    );
    const failed = vi.fn();
    const done = vi.fn();
    const checked = pending.then(done, failed);
    views.renderFailed("falsy", error);
    await checked;
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(done).not.toHaveBeenCalled();
    expect(useWindowViews.getState().entries.size).toBe(0);
  },
);

it("captures caret before inert blurs a moving source, not after asynchronous state work", async () => {
  const { views } = fixture();
  await views.reconcile(snapshot([lease]));
  const focused = {
    ...dom,
    focus: { key: "draft", selection: { start: 2, end: 9, direction: "forward" as const } },
  };
  let current: PanelDomState = focused;
  views.registerRoot("connections", () => current);
  views.setMoving("connections", true, lease);
  current = { ...focused, focus: null };
  // A duplicate freeze must not replace the last focused source snapshot.
  views.setMoving("connections", true, lease);
  expect((await views.captureAsync("connections")).dom.focus).toEqual(focused.focus);
  views.setMoving("connections", false, lease);
  expect((await views.captureAsync("connections")).dom.focus).toBeNull();
});

it("opts in only explicitly approved plugin descriptors and preserves the same descriptor/controller through commit", async () => {
  const { views } = fixture();
  const plugin = {
    panelId: "plugin:sample:files",
    revision: "a1",
    pluginId: "sample",
    runtimeId: "r1",
    generation: 4,
    viewId: "files",
    entry: "index.mjs",
    sdkVersion: "0.1.0",
    title: "Sample",
    allowFloating: true,
  };
  await views.reconcile({ ...snapshot(), pluginViews: [plugin] });
  const offer = {
    id: "plugin-offer",
    lease: { panelId: plugin.panelId, windowId: "source", generation: 3 },
    targetWindow: "main",
  };
  const staged = views.stage(offer, null, new AbortController().signal);
  const record = useWindowViews.getState().entries.get(plugin.panelId)!;
  expect(record.plugin).toBe(plugin);
  views.rendered(offer.id);
  await staged;
  await views.reconcile({
    ...snapshot([{ ...offer.lease, windowId: "main", generation: 5 }]),
    pluginViews: [{ ...plugin }],
  });
  const promoted = useWindowViews.getState().entries.get(plugin.panelId)!;
  expect(promoted.plugin).toBe(plugin);
  expect(promoted.key).toBe(record.key);
  expect(promoted.controller).toBe(record.controller);
  expect(promoted.staged).toBe(false);
  await views.reconcile({
    ...snapshot([{ ...offer.lease, windowId: "main", generation: 6 }]),
    pluginViews: [{ ...plugin, revision: "replacement" }],
  });
  expect(() => record.controller.capture()).toThrow("disposed");
  expect(useWindowViews.getState().entries.get(plugin.panelId)!.plugin!.revision).toBe(
    "replacement",
  );
});
it("withdrawal immediately rejects staged readiness and cannot retain an unapproved factory tree", async () => {
  const { views } = fixture();
  const plugin = {
    panelId: "plugin:sample:files",
    revision: "a1",
    pluginId: "sample",
    runtimeId: "r1",
    generation: 4,
    viewId: "files",
    entry: "index.mjs",
    sdkVersion: "0.1.0",
    title: "Sample",
    allowFloating: true,
  };
  await views.reconcile({ ...snapshot(), pluginViews: [plugin] });
  const offer = {
    id: "retired-offer",
    lease: { panelId: plugin.panelId, windowId: "source", generation: 3 },
    targetWindow: "main",
  };
  const staged = views.stage(offer, null, new AbortController().signal);
  const rejected = expect(staged).rejects.toThrow("cancelled");
  await views.reconcile({ ...snapshot([], [{ offer, ready: false }]), pluginViews: [] });
  await rejected;
  expect(useWindowViews.getState().entries.has(plugin.panelId)).toBe(false);
  await expect(views.stage(offer, null, new AbortController().signal)).rejects.toThrow(
    "unsupportedView",
  );
});
