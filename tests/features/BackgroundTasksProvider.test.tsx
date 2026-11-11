import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
import i18n from "@/i18n/i18n";
import { BackgroundTasks, DockedBackgroundTasks } from "@/features/tasks/BackgroundTasks";
import { registerBackgroundTaskSource, useBackgroundTasks } from "@/lib/tasks/registry";
import { useBackgroundTaskPanel } from "@/store/backgroundTaskPanel";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { PluginInfo } from "@/lib/api/types";
import type { FrontendBackgroundTasks, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
const plugin = {
  id: "tasks-ui",
  name: "Tasks UI",
  status: "running",
  fingerprint: "approved",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "backgroundTasks.read", "backgroundTasks.write"],
  views: [{ id: "tasks", title: "Tasks", kind: "component", provider: "backgroundTasks" }],
} as PluginInfo;
let retained: FrontendBackgroundTasks, stop: () => void, changed: () => void;
let omit = false;
const retry = vi.fn();
function Provider({ backgroundTasks }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = backgroundTasks!;
  });
  const Entries = backgroundTasks!.Entries;
  return <section aria-label="Custom task view">{omit ? "Entries omitted" : <Entries />}</section>;
}
beforeEach(async () => {
  mockCommittedViewScopes();
  await i18n.changeLanguage("en-US");
  omit = false;
  retry.mockReset();
  useWorkspace.setState({ tabs: [] });
  useNavigation.setState({ sidebarVisible: false });
  useBackgroundTaskPanel.setState({ open: true, pinned: false, bounds: null });
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      uiProviders: { backgroundTasks: { pluginId: plugin.id, viewId: "tasks" } },
    },
  });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, restricted: false, grants: { [plugin.id]: plugin.permissions } },
  }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "token").mockReturnValue("token");
  stop = registerBackgroundTaskSource({
    id: "provider-test",
    snapshot: () => [
      {
        id: "one",
        title: "Recover index",
        status: "attention",
        execution: "native",
        updatedAt: 0,
        actions: [{ id: "retry", label: "Retry index", run: retry }],
      },
    ],
    subscribe: (listener) => {
      changed = listener;
      return () => {};
    },
  });
});
afterEach(() => {
  cleanup();
  stop();
  vi.restoreAllMocks();
});

it("preserves native task nodes and host controls through provider restoration", async () => {
  render(<BackgroundTasks />);
  const row = await screen.findByRole("article", { name: "Recover index" });
  expect(screen.getByRole("region", { name: "Custom task view" }).contains(row)).toBe(true);
  expect(retained.snapshot.presentation).toBe("floating");
  expect(screen.getByRole("button", { name: "Clear finished tasks" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Background tasks" })).toBeTruthy();
  const old = retained;
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } })),
  );
  expect(screen.getByRole("article", { name: "Recover index" })).toBe(row);
  expect(() => old.read({ revision: old.snapshot.revision })).toThrow("viewUnavailable");
});

it("retires old actions on publication, selection and permission changes", async () => {
  render(<BackgroundTasks />);
  await screen.findByRole("region", { name: "Custom task view" });
  const old = retained;
  act(changed);
  await expect(
    old.runAction({ revision: old.snapshot.revision, key: "task:0", actionId: "retry" }),
  ).rejects.toThrow("changed");
  await retained.runAction({
    revision: retained.snapshot.revision,
    key: "task:0",
    actionId: "retry",
  });
  expect(retry).toHaveBeenCalledOnce();
  const current = retained;
  act(() =>
    usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: true } })),
  );
  await expect(
    current.runAction({ revision: current.snapshot.revision, key: "task:0", actionId: "retry" }),
  ).rejects.toThrow("viewUnavailable");
  expect(screen.getByRole("article", { name: "Recover index" })).toBeTruthy();
});

it("omits Entries without cancelling native tasks and invalidates actions in inactive embedded panels", async () => {
  omit = true;
  useNavigation.setState({ sidebarVisible: true, activeSidebar: "tasks" });
  render(<DockedBackgroundTasks />);
  await screen.findByText("Entries omitted");
  expect(retained.snapshot.presentation).toBe("embedded");
  expect(useBackgroundTasks.getState().items).toHaveLength(1);
  const old = retained;
  act(() => useNavigation.setState({ sidebarVisible: false }));
  await expect(
    old.runAction({ revision: old.snapshot.revision, key: "task:0", actionId: "retry" }),
  ).rejects.toThrow("changed");
  expect(retry).not.toHaveBeenCalled();
});

it("recovers native Entries after a duplicate mount without dropping task ownership", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(({ backgroundTasks }) => {
    const Entries = backgroundTasks!.Entries;
    return (
      <>
        <Entries />
        <Entries />
      </>
    );
  });
  render(<BackgroundTasks />);
  await screen.findByRole("alert");
  expect(screen.getAllByRole("article", { name: "Recover index" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry index" }));
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(useBackgroundTasks.getState().items).toHaveLength(1);
});
