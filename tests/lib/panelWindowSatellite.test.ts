import { afterEach, expect, it, vi } from "vitest";
import { startSatelliteViews } from "@/lib/panels/windowSatellite";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowViews } from "@/lib/panels/windowViews";
import type { NativePanelSnapshot, PanelWindowCommand } from "@/lib/panels/windowProtocol";
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
});
function fixture() {
  let snapshot: NativePanelSnapshot = { windows: [], panels: [], transfers: [] };
  let changed = () => {};
  const control = vi.fn(async (request: PanelWindowCommand) => {
    if (request.action === "prepare")
      snapshot = {
        ...snapshot,
        transfers: [
          ...snapshot.transfers,
          {
            offer: { id: "return", lease: request.lease, targetWindow: request.targetWindow },
            ready: false,
          },
        ],
      };
    return request.action === "staged" ? { state: "draft" } : null;
  });
  const client = {
    windowId: "panel-one",
    control,
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(async (receive: () => void) => {
      changed = receive;
      return vi.fn();
    }),
    onClose: vi.fn(async () => vi.fn()),
    destroy: vi.fn().mockResolvedValue(null),
  } as unknown as PanelWindowClient;
  const views = {
    reconcile: vi.fn().mockResolvedValue(null),
    capture: vi.fn().mockReturnValue("captured"),
    stage: vi.fn().mockResolvedValue(null),
  } as unknown as WindowViews;
  const failure = vi.fn(),
    receive = vi.fn();
  const session = startSatelliteViews(client, views, { failure, receive });
  dispose.push(session.dispose);
  return {
    client,
    views,
    control,
    session,
    failure,
    receive,
    set: (value: NativePanelSnapshot) => {
      snapshot = value;
      changed();
    },
  };
}
it("does not acknowledge an offered view until its real render adapter resolves", async () => {
  const f = fixture();
  await f.session.ready;
  await settle();
  let finish!: () => void;
  vi.mocked(f.views.stage).mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const offer = {
    id: "offer",
    lease: { panelId: "connections", windowId: "main", generation: 1 },
    targetWindow: "panel-one",
  };
  f.set({ windows: [], panels: [offer.lease], transfers: [{ offer, ready: false }] });
  await settle();
  expect(f.views.stage).toHaveBeenCalledWith(offer, "draft", expect.any(AbortSignal));
  expect(f.control).not.toHaveBeenCalledWith({ action: "acknowledge", id: offer.id });
  finish();
  await settle();
  expect(f.control).toHaveBeenCalledWith({ action: "acknowledge", id: offer.id });
  expect(f.control).not.toHaveBeenCalledWith(expect.objectContaining({ action: "commit" }));
});
it("cancels stale rendering before granting ownership and keeps source resources untouched", async () => {
  const f = fixture();
  await f.session.ready;
  await settle();
  let finish!: () => void, signal!: AbortSignal;
  vi.mocked(f.views.stage).mockImplementationOnce((_offer, _state, current) => {
    signal = current;
    return new Promise((done) => {
      finish = done;
    });
  });
  const offer = {
    id: "offer",
    lease: { panelId: "connections", windowId: "main", generation: 1 },
    targetWindow: "panel-one",
  };
  f.set({ windows: [], panels: [offer.lease], transfers: [{ offer, ready: false }] });
  await settle();
  f.set({ windows: [], panels: [offer.lease], transfers: [] });
  await settle();
  expect(signal.aborted).toBe(true);
  finish();
  await settle();
  expect(f.control).not.toHaveBeenCalledWith({ action: "acknowledge", id: "offer" });
});
it("captures before close, prepares all returns, then destroys only an empty committed window", async () => {
  const f = fixture();
  await f.session.ready;
  await settle();
  const lease = { panelId: "connections", windowId: "panel-one", generation: 3 };
  f.set({ windows: [], panels: [lease], transfers: [] });
  await settle();
  await f.session.close();
  await settle();
  expect(f.views.capture).toHaveBeenCalledWith("connections");
  expect(f.control).toHaveBeenCalledWith({
    action: "prepare",
    lease,
    targetWindow: "main",
    state: "captured",
  });
  expect(f.client.destroy).not.toHaveBeenCalled();
  f.set({ windows: [], panels: [{ ...lease, windowId: "main", generation: 4 }], transfers: [] });
  await settle();
  expect(f.client.destroy).toHaveBeenCalledWith("panel-one");
});
it("restores an interactive satellite when close fails instead of discarding its views", async () => {
  const f = fixture();
  await f.session.ready;
  await settle();
  f.control.mockRejectedValueOnce(new Error("interaction in progress"));
  await f.session.close();
  expect(f.control).toHaveBeenCalledWith({ action: "cancelClose" });
  expect(f.failure).toHaveBeenCalledOnce();
  expect(f.client.destroy).not.toHaveBeenCalled();
});

it("rolls back a timed-out close return rather than permanently freezing the satellite", async () => {
  const f = fixture();
  await f.session.ready;
  await settle();
  const lease = { panelId: "connections", windowId: "panel-one", generation: 3 };
  f.set({ windows: [], panels: [lease], transfers: [] });
  await settle();
  await f.session.close();
  await settle();
  f.set({ windows: [], panels: [lease], transfers: [] });
  await settle();
  expect(f.control).toHaveBeenCalledWith({ action: "cancelClose" });
  expect(f.failure).toHaveBeenCalledWith(
    expect.objectContaining({ message: "panel.window.closeCancelled" }),
  );
  expect(f.client.destroy).not.toHaveBeenCalled();
});
