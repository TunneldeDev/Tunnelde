import { expect, it, vi } from "vitest";
import { synchronizeContributions, type ContributionSource } from "@/lib/plugins/contributionSync";

type Snapshot = { revision: number; items: string[] };
const snapshot = (revision: number, ...items: string[]): Snapshot => ({ revision, items });
function fixture() {
  const events = new Map<string, (...args: never[]) => void>();
  const pending: Array<{ resolve(value: Snapshot): void; reject(error: Error): void }> = [];
  const source: ContributionSource<Snapshot> = {
    read: vi.fn(
      () => new Promise<Snapshot>((resolve, reject) => pending.push({ resolve, reject })),
    ),
    changed: vi.fn(async (receive) => {
      events.set("changed", receive as (...args: never[]) => void);
      return () => {
        events.delete("changed");
      };
    }),
    invalidated: vi.fn(async (receive) => {
      events.set("invalidated", receive);
      return () => {
        events.delete("invalidated");
      };
    }),
    resumed: vi.fn(async (receive) => {
      events.set("resumed", receive);
      return () => {
        events.delete("resumed");
      };
    }),
    apply: vi.fn(),
    clear: vi.fn(),
    report: vi.fn(),
  };
  const emit = (event: string, value?: Snapshot) => events.get(event)?.(value as never);
  return { source, pending, emit, events };
}
it("subscribes before reading and does not overwrite a newer event with a delayed snapshot", async () => {
  const f = fixture(),
    controller = new AbortController();
  const wiring = synchronizeContributions(f.source, controller.signal);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  expect(f.events.size).toBe(3);
  f.emit("changed", snapshot(4, "new"));
  f.pending[0]!.resolve(snapshot(1, "old"));
  const dispose = await wiring;
  f.emit("changed", snapshot(3, "stale"));
  expect(f.source.apply).toHaveBeenCalledExactlyOnceWith(snapshot(4, "new"));
  dispose();
  dispose();
  expect(f.events.size).toBe(0);
});
it("fences queued pre-revocation events until an authoritative post-change read", async () => {
  const f = fixture(),
    controller = new AbortController();
  const wiring = synchronizeContributions(f.source, controller.signal);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.pending[0]!.resolve(snapshot(4, "approved"));
  const dispose = await wiring;
  f.emit("resumed"); // started before permission revocation
  f.emit("invalidated");
  expect(f.source.clear).toHaveBeenCalledOnce();
  f.emit("changed", snapshot(5, "queued-old-event"));
  f.pending[1]!.resolve(snapshot(5, "stale-read"));
  f.pending[2]!.resolve(snapshot(6));
  await vi.waitFor(() => expect(f.pending).toHaveLength(4));
  expect(f.source.apply).toHaveBeenCalledTimes(1);
  f.pending[3]!.resolve(snapshot(6));
  await vi.waitFor(() => expect(f.source.apply).toHaveBeenLastCalledWith(snapshot(6)));
  f.emit("changed", snapshot(7, "newly-approved"));
  expect(f.source.apply).toHaveBeenLastCalledWith(snapshot(7, "newly-approved"));
  dispose();
});
it("keeps revoked content hidden after a failed refresh and recovers on resume", async () => {
  const f = fixture(),
    controller = new AbortController();
  const wiring = synchronizeContributions(f.source, controller.signal);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.pending[0]!.resolve(snapshot(1, "approved"));
  const dispose = await wiring;
  f.emit("invalidated");
  f.pending[1]!.reject(new Error("offline"));
  await vi.waitFor(() => expect(f.source.report).toHaveBeenCalledOnce());
  f.emit("changed", snapshot(2, "queued"));
  expect(f.source.apply).toHaveBeenCalledTimes(1);
  f.emit("resumed");
  f.pending[2]!.resolve(snapshot(3));
  await vi.waitFor(() => expect(f.source.apply).toHaveBeenLastCalledWith(snapshot(3)));
  dispose();
});
it("does not deliver reads or callbacks after abort, or register for an already aborted signal", async () => {
  const f = fixture(),
    controller = new AbortController();
  const wiring = synchronizeContributions(f.source, controller.signal);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  controller.abort();
  f.pending[0]!.resolve(snapshot(9, "late"));
  await wiring;
  expect(f.source.apply).not.toHaveBeenCalled();
  expect(f.events.size).toBe(0);
  const g = fixture();
  await synchronizeContributions(g.source, controller.signal);
  expect(g.source.read).not.toHaveBeenCalled();
  expect(g.source.changed).not.toHaveBeenCalled();
});
it("cleans up partial subscriptions if registration fails", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.source.resumed = vi.fn(async () => {
    throw new Error("registration failed");
  });
  await expect(synchronizeContributions(f.source, controller.signal)).rejects.toThrow(
    "registration failed",
  );
  expect(f.events.size).toBe(0);
  expect(f.source.read).not.toHaveBeenCalled();
});

it("a stale or duplicate event cannot cancel a newer reconciliation read", async () => {
  const f = fixture(),
    controller = new AbortController();
  const wiring = synchronizeContributions(f.source, controller.signal);
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  f.pending[0]!.resolve(snapshot(4, "current"));
  const dispose = await wiring;
  f.emit("resumed");
  f.emit("changed", snapshot(3, "old"));
  f.emit("changed", snapshot(4, "duplicate"));
  f.pending[1]!.resolve(snapshot(5, "reconciled"));
  await vi.waitFor(() =>
    expect(f.source.apply).toHaveBeenLastCalledWith(snapshot(5, "reconciled")),
  );
  dispose();
});
