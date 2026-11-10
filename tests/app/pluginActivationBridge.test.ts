import { describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/api/types";
import type { FrontendActivation } from "@/lib/plugins/activation/contracts";
import { createPluginActivationBridge } from "@/app/plugins/activationBridge";
import { createEventLifecycle } from "@/lib/events/lifecycle";

const plugin = (runtimeId = "boot:1", id = "sample") =>
  ({ id, runtimeId, status: "running", frontend: { entry: "index.mjs" } }) as PluginInfo;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  const state = { items: [] as PluginInfo[], stoppingIds: [] as string[] };
  let receive!: (request: FrontendActivation) => void;
  const unsubscribe = vi.fn();
  const transport = {
    subscribe: vi.fn(async (handler: typeof receive, _signal: AbortSignal) => {
      receive = handler;
      return unsubscribe;
    }),
    read: () => state,
    load: vi.fn(async () => {}),
    ensure: vi.fn(async (_plugin: PluginInfo) => {}),
    report: vi.fn(),
  };
  const bridge = createPluginActivationBridge(transport);
  const controller = new AbortController();
  return {
    state,
    transport,
    bridge,
    controller,
    unsubscribe,
    register: () => bridge.subscription.register(controller.signal),
    send: (request: FrontendActivation = { id: "sample", runtimeId: "boot:1" }) => receive(request),
  };
}

describe("bootstrap frontend activation bridge", () => {
  it("loads an admitted frontend before the native start response, without starting engines", async () => {
    const f = fixture();
    await f.register();
    f.transport.load.mockImplementation(async () => {
      f.state.items = [plugin()];
    });
    f.send();
    await vi.waitFor(() => expect(f.transport.ensure).toHaveBeenCalledWith(plugin()));
    expect(f.transport.load).toHaveBeenCalledOnce();
  });

  it("uses current pushed state immediately and deduplicates the exact runtime", async () => {
    const f = fixture();
    f.state.items = [plugin()];
    const activation = deferred();
    f.transport.ensure.mockReturnValue(activation.promise);
    await f.register();
    f.send();
    f.send();
    await vi.waitFor(() => expect(f.transport.ensure).toHaveBeenCalledOnce());
    expect(f.transport.load).not.toHaveBeenCalled();
    activation.resolve();
  });

  it.each(["replacement", "stopped", "stopping", "removed"])(
    "does not activate a %s runtime after a late snapshot",
    async (change) => {
      const f = fixture();
      const loading = deferred();
      f.transport.load.mockReturnValue(loading.promise);
      await f.register();
      f.send();
      await vi.waitFor(() => expect(f.transport.load).toHaveBeenCalledOnce());
      f.state.items =
        change === "removed" ? [] : [plugin(change === "replacement" ? "boot:2" : "boot:1")];
      if (change === "stopped") f.state.items[0]!.status = "stopped";
      if (change === "stopping") f.state.stoppingIds = ["sample"];
      loading.resolve();
      await f.bridge.subscription.recover!(f.controller.signal);
      // Recovery may activate the replacement, but never lends it to the old request.
      if (change === "replacement")
        expect(f.transport.ensure.mock.calls.map(([p]) => p.runtimeId)).toEqual(["boot:2"]);
      else expect(f.transport.ensure).not.toHaveBeenCalled();
    },
  );

  it.each(["disposed", "aborted"])("ignores a late load when %s", async (reason) => {
    const f = fixture();
    const loading = deferred();
    f.transport.load.mockReturnValue(loading.promise);
    await f.register();
    f.send();
    await vi.waitFor(() => expect(f.transport.load).toHaveBeenCalledOnce());
    f.state.items = [plugin()];
    if (reason === "disposed") f.bridge.dispose();
    else f.controller.abort();
    loading.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.transport.ensure).not.toHaveBeenCalled();
    f.send();
    expect(f.transport.load).toHaveBeenCalledOnce();
  });

  it("bounds unfinished work and releases slots after completion", async () => {
    const f = fixture();
    const loading = deferred();
    f.transport.load.mockReturnValue(loading.promise);
    await f.register();
    for (let index = 0; index < 65; index++) f.send({ id: `plugin-${index}`, runtimeId: "boot:1" });
    await vi.waitFor(() =>
      expect(f.transport.report).toHaveBeenCalledWith(new Error("plugin.api.busy")),
    );
    expect(f.transport.load).toHaveBeenCalledTimes(64);
    loading.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    f.send({ id: "last", runtimeId: "boot:1" });
    await vi.waitFor(() => expect(f.transport.load).toHaveBeenCalledTimes(65));
    expect(f.transport.report).toHaveBeenCalledTimes(1);
  });

  it("reports load failures and permits a subsequent request for that runtime", async () => {
    const f = fixture();
    const error = new Error("read failed");
    f.transport.load.mockRejectedValueOnce(error);
    await f.register();
    f.send();
    await vi.waitFor(() => expect(f.transport.report).toHaveBeenCalledWith(error));
    f.state.items = [plugin()];
    f.send();
    await vi.waitFor(() => expect(f.transport.ensure).toHaveBeenCalledOnce());
  });

  it("recovers missed requests after event registration retries and releases subscriptions", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.transport.subscribe.mockRejectedValueOnce(new Error("listen failed"));
      const lifecycle = createEventLifecycle([f.bridge.subscription], f.transport.report);
      await lifecycle.start();
      f.state.items = [plugin(), { ...plugin("boot:2", "stopped"), status: "stopped" }];
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.transport.subscribe).toHaveBeenCalledTimes(2);
      expect(f.transport.ensure).toHaveBeenCalledExactlyOnceWith(plugin());
      lifecycle.dispose();
      f.bridge.dispose();
      expect(f.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores malformed requests without a snapshot or module load", async () => {
    const f = fixture();
    await f.register();
    for (const request of [
      null,
      {},
      { id: "sample", runtimeId: "" },
      { id: "x".repeat(257), runtimeId: "boot:1" },
    ])
      f.send(request as FrontendActivation);
    await Promise.resolve();
    expect(f.transport.load).not.toHaveBeenCalled();
    expect(f.transport.ensure).not.toHaveBeenCalled();
  });
});
