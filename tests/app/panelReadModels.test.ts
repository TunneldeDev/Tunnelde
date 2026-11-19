import { afterEach, expect, it, vi } from "vitest";
import { startPanelReadModels } from "@/app/panelReadModels";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import type { Host } from "@/lib/api/types";
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
it("publishes only explicit credential-free connection/appearance projections, then releases subscriptions", async () => {
  const oldHosts = useHosts.getState().hosts,
    oldSettings = useSettings.getState().settings;
  cleanups.push(() => {
    useHosts.setState({ hosts: oldHosts });
    useSettings.setState({ settings: oldSettings });
  });
  useHosts.setState({
    hosts: [
      {
        id: "h",
        name: "host label",
        password: "never-transport",
        credential: "never-transport",
      } as unknown as Host,
    ],
  });
  useSettings.setState({
    settings: {
      ...oldSettings,
      userCss: ".label { color: red; }",
      network: { ...oldSettings.network, defaultProxy: "private-proxy-reference" },
    },
  });
  const control = vi.fn().mockResolvedValue(null).mockResolvedValueOnce("producer-1");
  const client = { control } as unknown as PanelWindowClient;
  const failure = vi.fn();
  const stop = startPanelReadModels(client, failure);
  cleanups.push(stop);
  await settle();
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "publishModel",
      panelId: "connections",
      revision: 1,
      model: expect.objectContaining({
        connection: expect.objectContaining({ hosts: [{ id: "h", name: "host label" }] }),
        appearance: expect.objectContaining({
          userCss: ".label { color: red; }",
          titleBarStyle: oldSettings.titleBarStyle,
        }),
      }),
    }),
  );
  expect(JSON.stringify(control.mock.calls)).not.toContain("never-transport");
  expect(JSON.stringify(control.mock.calls)).not.toContain("private-proxy-reference");
  useHosts.setState({ hosts: [] });
  await settle();
  expect(control.mock.lastCall?.[0].revision).toBe(2);
  stop();
  useHosts.setState({ hosts: oldHosts });
  await settle();
  expect(control).toHaveBeenCalledTimes(3);
  expect(failure).not.toHaveBeenCalled();
});
