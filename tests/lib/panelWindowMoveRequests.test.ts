import { afterEach, expect, it, vi } from "vitest";
import { startPanelMoveRequests } from "@/lib/panels/windowMoveRequests";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelMoveJob } from "@/lib/panels/windowProtocol";
const mocks = vi.hoisted(() => ({ move: vi.fn() }));
vi.mock("@/lib/panels/windowMoves", () => ({ movePanelToWindow: mocks.move }));
const job: PanelMoveJob = {
  id: "opaque-native-job",
  lease: { panelId: "tasks", windowId: "satellite", generation: 7 },
  targetWindow: "other",
};
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.clearAllMocks();
});
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  let changed = () => {};
  const unsubscribe = vi.fn();
  const claim = vi.fn().mockResolvedValue([]);
  const fail = vi.fn().mockResolvedValue(undefined);
  const failure = vi.fn();
  const client = {
    subscribe: vi.fn(async (refresh: () => void) => {
      changed = refresh;
      return unsubscribe;
    }),
    claimPanelMoves: claim,
    failPanelMove: fail,
  } as unknown as PanelWindowClient;
  return { client, claim, fail, failure, changed: () => changed(), unsubscribe };
}
it("claims source jobs after subscribing, routes the exact expected lease and releases completion", async () => {
  const f = fixture();
  f.claim.mockResolvedValueOnce([job]);
  mocks.move.mockResolvedValue(undefined);
  stops.push(startPanelMoveRequests(f.client, f.failure));
  await tick();
  expect(mocks.move).toHaveBeenCalledExactlyOnceWith(
    "tasks",
    "other",
    job.lease,
    job.id,
    expect.any(AbortSignal),
  );
  expect(f.fail).toHaveBeenCalledExactlyOnceWith(job.id);
  expect(f.failure).not.toHaveBeenCalled();
  f.changed();
  await tick();
  expect(f.claim).toHaveBeenCalledTimes(2);
});
it("capture/move rejection fails only the native reservation, including a throwing diagnostic", async () => {
  const f = fixture();
  f.claim.mockResolvedValueOnce([job]);
  mocks.move.mockRejectedValue(new Error("private source capture error"));
  f.failure.mockImplementation(() => {
    throw new Error("diagnostic failed");
  });
  stops.push(startPanelMoveRequests(f.client, f.failure));
  await tick();
  expect(f.failure).toHaveBeenCalledOnce();
  expect(f.fail).toHaveBeenCalledExactlyOnceWith(job.id); // no private error payload
});
it("disposal cancels in-flight requests and late claims cannot start retired views", async () => {
  const f = fixture();
  let settle!: (jobs: PanelMoveJob[]) => void;
  f.claim.mockImplementationOnce(
    () =>
      new Promise<PanelMoveJob[]>((resolve) => {
        settle = resolve;
      }),
  );
  const stop = startPanelMoveRequests(f.client, f.failure);
  stops.push(stop);
  await tick();
  stop();
  settle([job]);
  await tick();
  expect(mocks.move).not.toHaveBeenCalled();
  expect(f.fail).toHaveBeenCalledWith(job.id);
  expect(f.unsubscribe).toHaveBeenCalled();
  const second = fixture();
  second.claim.mockResolvedValueOnce([job]);
  let done!: () => void;
  mocks.move.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const stopSecond = startPanelMoveRequests(second.client, second.failure);
  stops.push(stopSecond);
  await tick();
  stopSecond();
  expect(second.fail).toHaveBeenCalledWith(job.id);
  done();
  await tick();
  expect(second.failure).not.toHaveBeenCalled();
});
it("late subscriptions are retired and unsubscribe prevents another claim", async () => {
  const f = fixture();
  let resolve!: (stop: () => void) => void;
  vi.mocked(f.client.subscribe).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const stop = startPanelMoveRequests(f.client, f.failure);
  stops.push(stop);
  stop();
  resolve(f.unsubscribe);
  await tick();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.claim).not.toHaveBeenCalled();
});
