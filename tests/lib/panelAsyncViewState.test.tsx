import { useLayoutEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPanelViewState,
  PanelViewStateGroup,
  PanelViewStateScope,
  usePanelViewController,
} from "@/lib/panels/viewState";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("preserves synchronous compatibility but never silently omits an async field", async () => {
  const state = createPanelViewState();
  state.register("sync", () => "draft");
  expect(await state.captureAsync()).toEqual(state.capture());
  state.registerAsync("async", async () => ({ query: "saved" }));
  expect(() => state.capture()).toThrow("asyncRequired");
  expect(await state.captureAsync()).toEqual({
    version: 1,
    fields: { sync: "draft", async: { query: "saved" } },
  });
  state.dispose();
});
it.each([undefined, Infinity, NaN, () => {}, new Date(), "x".repeat(1024 * 1024)])(
  "rejects unrepresentable async state without truncating",
  async (value) => {
    const state = createPanelViewState();
    state.registerAsync("draft", async () => value);
    await expect(state.captureAsync()).rejects.toThrow("panel.viewState.");
    state.dispose();
  },
);
it("shares one actual capture; cancelling a waiter does not start duplicate plugin work", async () => {
  const state = createPanelViewState(),
    result = deferred<unknown>();
  const capture = vi.fn(() => result.promise);
  state.registerAsync("draft", capture);
  const caller = new AbortController();
  const cancelled = expect(state.captureAsync(caller.signal)).rejects.toThrow("cancelled");
  caller.abort();
  await cancelled;
  const second = state.captureAsync(),
    third = state.captureAsync();
  expect(capture).toHaveBeenCalledOnce();
  result.resolve("private");
  expect(await second).toEqual(await third);
  state.dispose();
});
it("keeps a timed-out uncooperative capture charged until its actual settlement", async () => {
  vi.useFakeTimers();
  const state = createPanelViewState(),
    result = deferred<unknown>();
  const capture = vi.fn(() => result.promise);
  state.registerAsync("draft", capture);
  const timedOut = expect(state.captureAsync()).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(15000);
  await timedOut;
  await expect(state.captureAsync()).rejects.toThrow("limit");
  expect(capture).toHaveBeenCalledOnce();
  result.resolve("late");
  await tick();
  expect((await state.captureAsync()).fields.draft).toBe("late");
  expect(capture).toHaveBeenCalledTimes(2);
  state.dispose();
});
it("does not release the capture lane when a sibling fails ahead of an uncooperative callback", async () => {
  const state = createPanelViewState(),
    slow = deferred<unknown>();
  const capture = vi.fn(() => slow.promise);
  state.registerAsync("slow", capture);
  state.registerAsync("bad", async () => {
    throw new Error("failure");
  });
  const first = expect(state.captureAsync()).rejects.toThrow("failure");
  await tick();
  const second = expect(state.captureAsync()).rejects.toThrow("failure");
  expect(capture).toHaveBeenCalledOnce();
  slow.resolve("done");
  await first;
  await second;
  state.dispose();
});
it.each(["change", "replace", "dispose"])("rejects a late capture after %s", async (action) => {
  const state = createPanelViewState(),
    result = deferred<unknown>();
  const release = state.registerAsync("draft", () => result.promise);
  const pending = expect(state.captureAsync()).rejects.toThrow();
  if (action === "change") state.changed();
  else if (action === "replace") {
    release();
    state.registerAsync("draft", async () => "new");
  } else state.dispose();
  result.resolve("old");
  await pending;
  state.dispose();
});
it("readiness includes fields committed by an asynchronous renderer, not only the loading shell", async () => {
  const state = createPanelViewState(),
    shell = deferred<void>(),
    child = deferred<void>();
  state.registerAsync(
    "factory",
    async () => null,
    () => shell.promise,
  );
  const ready = vi.fn();
  const wait = state.waitReady(new AbortController().signal).then(ready);
  state.registerAsync(
    "child",
    async () => "draft",
    () => child.promise,
  );
  shell.resolve();
  await tick();
  expect(ready).not.toHaveBeenCalled();
  child.resolve();
  await wait;
  expect(ready).toHaveBeenCalledOnce();
  state.dispose();
});
it("bounds and cancels readiness without resolving a false-ready renderer", async () => {
  vi.useFakeTimers();
  const state = createPanelViewState();
  state.registerAsync(
    "draft",
    async () => null,
    () => new Promise(() => {}),
  );
  const controller = new AbortController();
  const cancelled = expect(state.waitReady(controller.signal)).rejects.toThrow("cancelled");
  controller.abort();
  await cancelled;
  const timeout = expect(state.waitReady(new AbortController().signal)).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(15000);
  await timeout;
  state.dispose();
});
it("captures and gates nested async groups under the same strict capsule bounds", async () => {
  const state = createPanelViewState(),
    child = deferred<void>();
  function AsyncField() {
    const controller = usePanelViewController();
    useLayoutEffect(
      () =>
        controller?.registerAsync(
          "async",
          async () => "nested",
          () => child.promise,
        ),
      [controller],
    );
    return null;
  }
  const ui = render(
    <PanelViewStateScope controller={state}>
      <PanelViewStateGroup name="group">
        <AsyncField />
      </PanelViewStateGroup>
    </PanelViewStateScope>,
  );
  const ready = vi.fn();
  const wait = state.waitReady(new AbortController().signal).then(ready);
  await tick();
  expect(ready).not.toHaveBeenCalled();
  child.resolve();
  await wait;
  expect(await state.captureAsync()).toEqual({
    version: 1,
    fields: { group: { version: 1, fields: { async: "nested" } } },
  });
  ui.unmount();
  state.dispose();
});

it("does not reuse a periodic checkpoint as a move barrier (or the reverse)", async () => {
  const state = createPanelViewState();
  const result = deferred<unknown>();
  const capture = vi.fn((_signal, options) =>
    options?.intent === "move" ? "detached" : result.promise,
  );
  state.registerAsync("terminal", capture);
  const checkpoint = state.captureAsync(undefined, { intent: "checkpoint" });
  await expect(state.captureAsync(undefined, { intent: "move" })).rejects.toThrow("moveInProgress");
  expect(capture).toHaveBeenCalledOnce();
  result.resolve("running");
  expect((await checkpoint).fields.terminal).toBe("running");
  expect((await state.captureAsync(undefined, { intent: "move" })).fields.terminal).toBe(
    "detached",
  );
  expect(capture).toHaveBeenCalledTimes(2);
  state.dispose();
});

it("treats legacy unspecified captures as checkpoints, but forwards explicit move intent", async () => {
  const state = createPanelViewState();
  const result = deferred<unknown>();
  const capture = vi.fn(() => result.promise);
  state.registerAsync("terminal", capture);
  const first = state.captureAsync();
  const second = state.captureAsync(undefined, { intent: "checkpoint" });
  result.resolve("same");
  expect(await first).toEqual(await second);
  expect(capture).toHaveBeenCalledOnce();
  await state.captureAsync(undefined, { intent: "move" });
  expect(capture).toHaveBeenLastCalledWith(expect.any(AbortSignal), { intent: "move" });
  state.dispose();
});
