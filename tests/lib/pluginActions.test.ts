import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { openPluginAction } from "@/lib/plugins/actions";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";

const plugin = {
  id: "sample",
  name: "Sample",
  version: "1.0.0",
  fingerprint: "one",
  status: "running",
  views: [],
  commands: [
    { id: "one", title: "One" },
    { id: "two", title: "Two" },
  ],
} as unknown as PluginInfo;

beforeEach(() => {
  usePlugins.setState({ items: [plugin], outputs: {}, busyIds: [], busy: null });
  vi.spyOn(useWorkspace.getState(), "openPluginView").mockImplementation(() => {});
});

describe("contributed plugin actions", () => {
  it("does not run a different package or changed contribution after delayed activation", async () => {
    for (const replacement of [
      { ...plugin, fingerprint: "replacement" },
      { ...plugin, commands: [{ id: "one", title: "Replaced" }] },
    ]) {
      usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const start = vi.spyOn(usePlugins.getState(), "start").mockImplementation(async () => {
        await gate;
        usePlugins.setState({ items: [replacement] });
      });
      const run = vi.spyOn(api, "pluginRun");
      const operation = openPluginAction({ id: plugin.id, command: "one" });
      await vi.waitFor(() => expect(start).toHaveBeenCalled());
      finish();
      await operation;
      expect(run).not.toHaveBeenCalled();
      start.mockRestore();
      run.mockRestore();
    }
  });
  it("does not publish a result from a package replaced during execution", async () => {
    let finish!: (result: unknown) => void;
    const run = vi.spyOn(api, "pluginRun").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const operation = openPluginAction({ id: plugin.id, command: "one" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    usePlugins.setState({ items: [{ ...plugin, fingerprint: "replacement" }] });
    finish({ text: "retired" });
    await operation;
    expect(usePlugins.getState().outputs[plugin.id]).toBeUndefined();
    expect(useWorkspace.getState().openPluginView).not.toHaveBeenCalled();
  });
  it("executes both commands for the same plugin in order, even while the first is pending", async () => {
    let finish!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const run = vi
      .spyOn(api, "pluginRun")
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ text: "two" });
    const one = openPluginAction({ id: plugin.id, command: "one" });
    const two = openPluginAction({ id: plugin.id, command: "two" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    finish({ text: "one" });
    await Promise.all([one, two]);
    expect(run.mock.calls.map((call) => call[1])).toEqual(["one", "two"]);
  });

  it("does not execute a queued command after the plugin is replaced", async () => {
    let finish!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const run = vi.spyOn(api, "pluginRun").mockReturnValueOnce(first);
    const one = openPluginAction({ id: plugin.id, command: "one" });
    const two = openPluginAction({ id: plugin.id, command: "two" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    usePlugins.setState({ items: [{ ...plugin, fingerprint: "replacement" }] });
    finish({ text: "one" });
    await Promise.all([one, two]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
