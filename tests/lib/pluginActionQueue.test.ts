import { beforeEach, expect, it, vi } from "vitest";
import { enqueuePluginAction } from "@/lib/plugins/commands/queue";
import { usePlugins } from "@/store/plugins";
import { deferred, plugin } from "../fixtures/plugins";

const running = { ...plugin, status: "running" as const, runtimeId: "boot:1" };
beforeEach(() => usePlugins.setState({ items: [running], stoppingIds: [] }));

it("settles queued actions on stop without waiting for a stuck active command", async () => {
  const gate = deferred<void>();
  const active = vi.fn(() => gate.promise);
  const queued = vi.fn(async () => {});
  const one = enqueuePluginAction(running, active);
  const two = enqueuePluginAction(running, queued);
  await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());
  usePlugins.setState({ stoppingIds: [plugin.id] });
  await Promise.all([one, two]);
  expect(queued).not.toHaveBeenCalled();
  usePlugins.setState({ stoppingIds: [], items: [{ ...running, runtimeId: "boot:2" }] });
  const newAction = vi.fn(async () => {});
  await enqueuePluginAction(usePlugins.getState().items[0]!, newAction);
  gate.resolve();
  expect(newAction).toHaveBeenCalledOnce();
  expect(queued).not.toHaveBeenCalled();
});

it("does not carry queued commands across identical-package runtime replacement", async () => {
  const gate = deferred<void>();
  const active = vi.fn(() => gate.promise);
  const queued = vi.fn(async () => {});
  const one = enqueuePluginAction(running, active);
  const two = enqueuePluginAction(running, queued);
  await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());
  usePlugins.setState({ items: [{ ...running, runtimeId: "boot:2" }] });
  await Promise.all([one, two]);
  gate.resolve();
  expect(queued).not.toHaveBeenCalled();
});

it("allows initial activation but cancels its queued users when stopped during setup", async () => {
  const stopped = { ...running, status: "stopped" as const, runtimeId: null };
  usePlugins.setState({ items: [stopped] });
  const gate = deferred<void>();
  const active = vi.fn(() => gate.promise);
  const queued = vi.fn(async () => {});
  const one = enqueuePluginAction(stopped, active);
  const two = enqueuePluginAction(stopped, queued);
  await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());
  usePlugins.setState({ stoppingIds: [plugin.id] });
  await Promise.all([one, two]);
  usePlugins.setState({ stoppingIds: [], items: [running] });
  gate.resolve();
  expect(queued).not.toHaveBeenCalled();
});

it("bounds retained actions and releases capacity immediately on cancellation", async () => {
  const gate = deferred<void>();
  const active = vi.fn(() => gate.promise);
  const requests = [enqueuePluginAction(running, active)];
  for (let index = 1; index < 32; index++) requests.push(enqueuePluginAction(running, active));
  await expect(enqueuePluginAction(running, active)).rejects.toThrow("plugin.api.busy");
  await vi.waitFor(() => expect(active).toHaveBeenCalledOnce());
  usePlugins.setState({ stoppingIds: [plugin.id] });
  await Promise.all(requests);
  usePlugins.setState({ stoppingIds: [] });
  await enqueuePluginAction(running, async () => {});
  gate.resolve();
});
