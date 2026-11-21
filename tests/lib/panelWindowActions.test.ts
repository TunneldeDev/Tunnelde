import { afterEach, expect, it, vi } from "vitest";
import { startWindowActions } from "@/lib/panels/windowActions";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelActionJob } from "@/lib/panels/windowProtocol";
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
const job = (id: string): PanelActionJob => ({
  id,
  lease: { panelId: "tasks", windowId: "satellite", generation: 1 },
  request: { kind: "clearTasks" },
});
function fixture(
  execute = vi.fn<(job: PanelActionJob) => Promise<unknown>>().mockResolvedValue(null),
) {
  let receive = () => {};
  const control = vi.fn().mockResolvedValue([]),
    finalizeAction = vi.fn().mockResolvedValue(null),
    release = vi.fn(),
    failure = vi.fn();
  const client = {
    windowId: "main",
    claimActions: control,
    finalizeAction,
    subscribe: vi.fn(async (fn: () => void) => {
      receive = fn;
      return release;
    }),
  } as unknown as PanelWindowClient;
  const executor = startWindowActions(client, execute, failure);
  stops.push(executor.dispose);
  return { executor, control, execute, finalizeAction, failure, release, refresh: () => receive() };
}
it("executes only host-claimed jobs, and one slow panel does not block another", async () => {
  let finish!: (value: unknown) => void;
  const execute = vi
    .fn<(job: PanelActionJob) => Promise<unknown>>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    )
    .mockResolvedValue(null);
  const f = fixture(execute);
  f.control.mockResolvedValueOnce([job("slow")]);
  await f.executor.ready;
  await settle();
  f.control.mockResolvedValueOnce([job("fast")]);
  f.refresh();
  await settle();
  expect(f.finalizeAction).toHaveBeenCalledWith("fast", { status: "done", value: null });
  expect(f.finalizeAction).not.toHaveBeenCalledWith("slow", expect.anything());
  finish(null);
  await settle();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(f.finalizeAction).toHaveBeenCalledWith("slow", { status: "done", value: null });
});
it("finalizes admitted singleton work even after lifecycle disposal, without starting new work", async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(
    vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    ),
  );
  f.control.mockResolvedValueOnce([job("admitted")]);
  await f.executor.ready;
  await settle();
  f.executor.dispose();
  finish(undefined);
  await settle();
  expect(f.finalizeAction).toHaveBeenCalledWith("admitted", { status: "done", value: null });
  f.refresh();
  await settle();
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});
it("cancels a late claim reply without invoking effects and transports bounded failures", async () => {
  let deliver!: (jobs: PanelActionJob[]) => void;
  const f = fixture();
  f.control.mockImplementationOnce(
    () =>
      new Promise((done) => {
        deliver = done;
      }),
  );
  await f.executor.ready;
  await settle();
  f.executor.dispose();
  deliver([job("late")]);
  await settle();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.finalizeAction).toHaveBeenCalledWith("late", {
    status: "failed",
    message: "panel.window.disposed",
  });
  const failed = fixture(vi.fn().mockRejectedValue(new Error("x".repeat(10_000))));
  failed.control.mockResolvedValueOnce([job("failed")]);
  await failed.executor.ready;
  await settle();
  expect(failed.finalizeAction.mock.calls[0]?.[1]).toEqual({
    status: "failed",
    message: "x".repeat(4096),
  });
});
