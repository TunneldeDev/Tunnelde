import { expect, it, vi } from "vitest";
import { disconnectConnectionBatch } from "@/lib/session/connectionBatch";

it("uses at most four workers, deduplicates IDs, and keeps failed items retryable", async () => {
  const releases: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  const disconnect = vi.fn(async (id: string) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    if (id === "b" || id === "f") throw new Error("offline");
  });
  const ids = ["a", "b", "c", "d", "e", "f", "a"];
  const pending = disconnectConnectionBatch(ids, disconnect);
  ids.push("not-confirmed");
  expect(disconnect.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "d"]);
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(6));
  releases.splice(0).forEach((release) => release());
  expect(await pending).toEqual({ closed: ["a", "c", "d", "e"], failed: ["b", "f"] });
  expect(maximum).toBe(4);
});

it("does no resource work for an empty confirmed selection", async () => {
  const disconnect = vi.fn();
  expect(await disconnectConnectionBatch([], disconnect)).toEqual({ closed: [], failed: [] });
  expect(disconnect).not.toHaveBeenCalled();
});
