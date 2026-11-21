import { afterEach, expect, it, vi } from "vitest";
import { startPluginPanelAppearance } from "@/app/pluginPanelAppearance";
import { usePanelWindows } from "@/store/panelWindows";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { NativePluginViewDescriptor } from "@/lib/panels/windowProtocol";
import type { WindowModelAppearance } from "@/app/panelReadModels";
const descriptor: NativePluginViewDescriptor = {
  panelId: "plugin:sample:files",
  revision: "approval",
  pluginId: "sample",
  runtimeId: "private-runtime",
  generation: 4,
  viewId: "files",
  entry: "index.mjs",
  sdkVersion: "0.1.0",
  title: "Sample",
  allowFloating: true,
};
const cleanups: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  usePanelWindows.setState({ snapshot: { windows: [], panels: [], transfers: [] } });
});
it("publishes only explicit appearance under an approval-bound producer and does not loop on identical snapshots", async () => {
  const model = {
    language: "en-US",
    platform: "macos",
    appearance: { theme: "dark" },
  } as WindowModelAppearance;
  const snapshot = { windows: [], panels: [], transfers: [], pluginViews: [descriptor] };
  usePanelWindows.setState({ snapshot });
  const control = vi.fn(async (command) =>
    command.action === "beginPluginModel" ? "producer" : null,
  );
  const failure = vi.fn();
  cleanups.push(
    startPluginPanelAppearance({ control } as unknown as PanelWindowClient, () => model, failure),
  );
  await settle();
  expect(control.mock.calls.map(([command]) => command)).toEqual([
    { action: "beginPluginModel", panelId: descriptor.panelId, revision: "approval" },
    {
      action: "publishModel",
      panelId: descriptor.panelId,
      publisher: "producer",
      revision: 1,
      model,
    },
  ]);
  usePanelWindows.setState({ snapshot: { ...snapshot, pluginViews: [{ ...descriptor }] } });
  await settle();
  expect(control).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(control.mock.calls)).not.toContain("private-runtime");
  expect(failure).not.toHaveBeenCalled();
});
it("discards a retired producer reply and opens a fresh producer for the replacement approval", async () => {
  usePanelWindows.setState({
    snapshot: { windows: [], panels: [], transfers: [], pluginViews: [descriptor] },
  });
  let release!: (value: string) => void;
  const control = vi.fn(async (command) =>
    command.action === "beginPluginModel" && command.revision === "approval"
      ? new Promise<string>((resolve) => {
          release = resolve;
        })
      : command.action === "beginPluginModel"
        ? "new-producer"
        : null,
  );
  const model = { language: "en-US", platform: "macos", appearance: {} } as WindowModelAppearance;
  cleanups.push(
    startPluginPanelAppearance({ control } as unknown as PanelWindowClient, () => model, vi.fn()),
  );
  usePanelWindows.setState({
    snapshot: {
      windows: [],
      panels: [],
      transfers: [],
      pluginViews: [{ ...descriptor, revision: "replacement" }],
    },
  });
  release("old-producer");
  await settle();
  expect(control).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "publishModel", publisher: "old-producer" }),
  );
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({ action: "publishModel", publisher: "new-producer", model }),
  );
});
