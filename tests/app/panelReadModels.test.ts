import { useKnownHostsSource } from "@/features/settings/knownHosts/source";
import { afterEach, expect, it, vi } from "vitest";
import { startPanelReadModels } from "@/app/panelReadModels";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { useOutputSource } from "@/features/output/source";
import { usePlugins } from "@/store/plugins";
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
  const control = vi.fn(async (request: { action: string; panelId: string; revision?: number }) =>
    request.action === "beginModel" ? `producer-${request.panelId}` : null,
  );
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
  expect(control.mock.calls.filter(([request]) => request.panelId === "connections")).toHaveLength(
    3,
  );
  expect(control.mock.calls.filter(([request]) => request.panelId === "tasks")).toHaveLength(2);
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "publishModel",
      panelId: "tasks",
      publisher: "producer-tasks",
      revision: 1,
      model: expect.objectContaining({ tasks: [] }),
    }),
  );
  expect(failure).not.toHaveBeenCalled();
});

it("projects output runtime metadata without settings, filesystem paths or frontend tokens", async () => {
  const plugins = usePlugins.getState().items,
    info = useSettings.getState().info;
  cleanups.push(() => {
    usePlugins.setState({ items: plugins });
    useSettings.setState({ info });
  });
  usePlugins.setState({
    items: [
      {
        id: "p",
        name: "Plugin",
        version: "1",
        status: "running",
        error: null,
        path: "never-plugin-path",
        runtimeId: "never-runtime-token",
        fingerprint: "never-fingerprint",
        permissions: ["secret"],
      },
    ] as unknown as typeof plugins,
  });
  useSettings.setState({
    info: {
      ...info,
      name: "Tunnelde",
      version: "2",
      os: "macos",
      arch: "aarch64",
      debug: true,
      tauriVersion: "2",
      dataDir: "never-data-path",
      logDir: "never-log-path",
      defaultSettings: { credential: "never-credential" },
    } as unknown as typeof info,
  });
  const control = vi.fn(async (request) => (request.action === "beginModel" ? "publisher" : null));
  const stop = startPanelReadModels({ control } as unknown as PanelWindowClient, vi.fn());
  cleanups.push(stop);
  await settle();
  const publication = control.mock.calls
    .map(([r]) => r)
    .find((r) => r.action === "publishModel" && r.panelId === "output");
  expect(publication.model.output).toMatchObject({
    entries: [],
    plugins: [{ id: "p", name: "Plugin" }],
    info: { name: "Tunnelde", debug: true },
  });
  expect(JSON.stringify(publication)).not.toMatch(/never-/);
  const source = useOutputSource.getState().source!;
  source.store.setState({ entries: [{ id: 3, message: "private output" }] as never });
  await settle();
  expect(control).toHaveBeenLastCalledWith(
    expect.objectContaining({
      panelId: "output",
      model: expect.objectContaining({
        output: expect.objectContaining({
          entries: [expect.objectContaining({ message: "private output" })],
        }),
      }),
    }),
  );
  stop();
  expect(useOutputSource.getState().source).toBeNull();
});

it("projects shared known-host state only to its own model and disposes the coordinator source", async () => {
  const control = vi.fn(async (request) => (request.action === "beginModel" ? "publisher" : null));
  const stop = startPanelReadModels({ control } as unknown as PanelWindowClient, vi.fn());
  cleanups.push(stop);
  const source = useKnownHostsSource.getState().source!;
  const entry = {
    host: "trusted.example",
    port: 22,
    algorithm: "ed25519",
    fingerprint: "SHA256:key",
    updatedAt: 1,
  };
  source.store.setState({ entries: [entry], loading: false });
  await settle();
  const models = control.mock.calls.map(([r]) => r).filter((r) => r.action === "publishModel");
  const known = models.filter((r) => r.panelId === "knownHosts").at(-1)!;
  expect(known.model.knownHosts).toEqual({ entries: [entry], loading: false, error: "" });
  expect(
    models
      .filter((r) => r.panelId !== "knownHosts")
      .every((r) => !JSON.stringify(r).includes("trusted.example")),
  ).toBe(true);
  stop();
  expect(useKnownHostsSource.getState().source).toBeNull();
});
