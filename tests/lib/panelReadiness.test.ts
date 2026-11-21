import { expect, it } from "vitest";
import { createPanelReadiness } from "@/lib/panels/readiness";
it("waits for committed readiness and never treats loading as a capture", async () => {
  const gate = createPanelReadiness(),
    lifetime = new AbortController();
  expect(() => gate.check()).toThrow("viewNotReady");
  let ready = false;
  const waiting = gate.wait(lifetime.signal).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  gate.commit(false);
  await Promise.resolve();
  expect(ready).toBe(false);
  gate.commit(true);
  await waiting;
  gate.check();
  gate.commit(false);
  expect(() => gate.check()).toThrow("viewNotReady");
  gate.dispose();
});
it("propagates discovery failures and supports a fresh explicit retry, not a silent builtin fallback", async () => {
  const gate = createPanelReadiness(),
    signal = new AbortController().signal;
  const waiting = expect(gate.wait(signal)).rejects.toThrow("discovery failed");
  gate.commit(false, new Error("discovery failed"));
  await waiting;
  expect(() => gate.check()).toThrow("discovery failed");
  await expect(gate.wait(signal)).rejects.toThrow("discovery failed");
  gate.commit(false);
  const retry = gate.wait(signal);
  gate.commit(true);
  await retry;
  gate.dispose();
});
it("cancels only the original waiter, rejects disposed generations and cannot revive them", async () => {
  const gate = createPanelReadiness(),
    a = new AbortController(),
    b = new AbortController();
  const first = expect(gate.wait(a.signal)).rejects.toThrow("cancelled");
  const second = gate.wait(b.signal);
  a.abort();
  await first;
  gate.commit(true);
  await second;
  gate.commit(false);
  const retired = expect(gate.wait(b.signal)).rejects.toThrow("cancelled");
  gate.dispose();
  await retired;
  gate.commit(true);
  expect(() => gate.check()).toThrow("cancelled");
  await expect(gate.wait(b.signal)).rejects.toThrow("cancelled");
});
it("rejects pre-aborted waits without allocating an unobserved work promise", async () => {
  const gate = createPanelReadiness(),
    lifetime = new AbortController();
  lifetime.abort();
  const rejected = expect(gate.wait(lifetime.signal)).rejects.toThrow("cancelled");
  gate.dispose();
  await rejected;
  const ready = createPanelReadiness();
  ready.commit(true);
  await expect(ready.wait(lifetime.signal)).rejects.toThrow("cancelled");
  ready.dispose();
});
