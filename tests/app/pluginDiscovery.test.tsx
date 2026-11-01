import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { plugin } from "../fixtures/plugins";

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  events: {
    onSettingsChanged: vi.fn(async () => vi.fn()),
    onUpdateState: vi.fn(async () => vi.fn()),
    onNavigate: vi.fn(async () => vi.fn()),
    onPluginState: vi.fn(async () => vi.fn()),
    onPluginSecurity: vi.fn(async () => vi.fn()),
    onTransfer: vi.fn(async () => vi.fn()),
    onSshClosed: vi.fn(async () => vi.fn()),
  },
}));
vi.mock("@/lib/api/ipc", () => ({
  isTauri: () => true,
  events: mock.events,
  api: {
    pluginsList: mock.list,
    pluginStart: mock.start,
    tabs: async () => [
      {
        id: "sidebar:plugin:formatter:chat",
        kind: "sidebar",
        title: "AI assistant",
        hostId: null,
        pinned: false,
        sortOrder: 0,
        state: null,
      },
    ],
    saveTabs: vi.fn(async () => undefined),
  },
}));
vi.mock("@/app/pluginWorkspaceBridge", () => ({ wirePluginWorkspaceBridge: async () => vi.fn() }));
vi.mock("@/store/settings", () => ({
  useSettings: {
    getState: () => ({ load: async () => undefined, settings: { restoreWorkspace: true } }),
  },
}));
vi.mock("@/store/pluginSecurity", () => ({
  reportPluginExecutionFailure: vi.fn(),
  usePluginSecurity: { getState: () => ({ load: async () => undefined }) },
}));
vi.mock("@/store/hosts", () => ({
  useHosts: { getState: () => ({ load: async () => true, hosts: [] }) },
}));
vi.mock("@/store/ssh", () => ({
  useSsh: { getState: () => ({ refresh: async () => undefined }) },
}));
vi.mock("@/store/updates", () => ({
  useUpdates: { getState: () => ({ refresh: async () => undefined }) },
}));
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));

import { bootstrap } from "@/app/bootstrap";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { PluginSidebarPanel } from "@/features/plugins/PluginSidebarPanel";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";

afterEach(() => vi.useRealTimers());

it("discovers restored plugin sidebars and their activity icons through application startup alone", async () => {
  vi.useFakeTimers();
  vi.mocked(window.matchMedia).mockReturnValue({
    addEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  await i18n.changeLanguage("en-US");
  usePlugins.setState({ items: [] });
  mock.list.mockResolvedValue([
    {
      ...plugin,
      status: "stopped",
      views: [
        { id: "chat", title: "AI assistant", location: "sidebar", kind: "chat", icon: "bot" },
      ],
    },
  ]);
  render(
    <>
      <ActivityBar />
      <PluginSidebarPanel view="plugin:formatter:chat" />
    </>,
  );
  expect(screen.queryByRole("button", { name: "AI assistant" })).toBeNull();

  await act(async () => bootstrap());

  expect(screen.getByRole("button", { name: "AI assistant" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  expect(screen.queryByText(i18n.t("pluginChat.missingView"))).toBeNull();
  expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toContain(
    "sidebar:plugin:formatter:chat",
  );
  expect(mock.list).toHaveBeenCalledOnce();
  expect(mock.start).not.toHaveBeenCalled();
  expect(usePlugins.getState().items[0]?.status).toBe("stopped");
});
