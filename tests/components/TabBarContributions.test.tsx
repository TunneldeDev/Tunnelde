import { fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TabBarContributions } from "@/components/layout/TabBarContributions";
import { registerTabBarContent, useTabBarContent, usePluginTabBar } from "@/store/tabBar";
import { tabBarMatches, type PluginTabBarItem } from "@/lib/plugins/tabBar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const context = { tabId: "sidebar:output", tabKind: "sidebar", paneId: "pane-1" };
const item: PluginTabBarItem = {
  id: "test",
  title: "Target",
  kind: "button",
  priority: 0,
  icon: "play",
  command: "run",
  disabled: false,
  when: {},
  options: [],
  value: null,
  pluginId: "sample",
  pluginName: "Sample",
  token: "host-issued-token",
};
beforeEach(() => {
  useTabBarContent.setState({ items: [] });
  usePluginTabBar.setState({ revision: -1, items: [] });
  vi.mocked(invoke).mockResolvedValue(null);
});

it("registers scoped core content, replaces it and ignores an old owner's late disposal", () => {
  const first = registerTabBarContent({
    id: "actions",
    tabId: context.tabId,
    priority: 0,
    content: <button>Old</button>,
  });
  const second = registerTabBarContent({
    id: "actions",
    tabId: context.tabId,
    priority: 0,
    content: <button>Current</button>,
  });
  first();
  render(<TabBarContributions context={context} />);
  expect(screen.getByRole("button", { name: "Current" })).toBeTruthy();
  expect(screen.queryByText("Old")).toBeNull();
  act(second);
  expect(screen.queryByText("Current")).toBeNull();
});

it("defaults to own views and matches explicit tab filters without leaking into other tabs", () => {
  const own = { ...item, when: null };
  expect(tabBarMatches(own, context)).toBe(false);
  expect(tabBarMatches(own, { ...context, tabId: "plugin:sample:main", tabKind: "plugin" })).toBe(
    true,
  );
  expect(tabBarMatches(own, { ...context, tabId: "sidebar:plugin:sample:main" })).toBe(true);
  expect(
    tabBarMatches(own, { ...context, tabId: "plugin:sample-other:main", tabKind: "plugin" }),
  ).toBe(false);
  expect(tabBarMatches({ ...item, when: { tabKind: "editor" } }, context)).toBe(false);
  expect(tabBarMatches({ ...item, when: { tabId: "sidebar:output" } }, context)).toBe(true);
});

it("renders plugin controls with plugin identity and executes the host-issued token", async () => {
  usePluginTabBar.setState({ items: [item] });
  render(<TabBarContributions context={context} />);
  fireEvent.click(screen.getByRole("button", { name: "Sample: Target" }));
  expect(invoke).toHaveBeenCalledWith(
    "plugin_tab_bar_execute",
    expect.objectContaining({ token: "host-issued-token", context, value: null }),
  );
  await act(() => Promise.resolve());
});

it("places contributions in their requested slots and renders labelled toggles", () => {
  usePluginTabBar.setState({
    items: [
      {
        ...item,
        placement: "leading",
        group: "execution",
        showLabel: true,
        checked: true,
        tooltip: "Run current document",
      },
    ],
  });
  registerTabBarContent({
    id: "core",
    tabId: context.tabId,
    priority: 0,
    placement: "leading",
    content: <button>Core target</button>,
  });
  const view = render(<TabBarContributions context={context} />);
  expect(screen.queryByRole("button", { name: "Sample: Target" })).toBeNull();
  view.rerender(<TabBarContributions context={context} placement="leading" />);
  const button = screen.getByRole("button", { name: "Sample: Target" });
  expect(button.textContent).toBe("Target");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.title).toBe("Sample: Run current document");
  expect(screen.getByRole("button", { name: "Core target" })).toBeTruthy();
});

it("guards duplicate execution across host updates and keeps host-owned toggle state", async () => {
  let finish!: () => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  usePluginTabBar.setState({ items: [{ ...item, checked: false }] });
  render(<TabBarContributions context={context} />);
  fireEvent.click(screen.getByRole("button", { name: "Sample: Target" }));
  act(() => usePluginTabBar.setState({ items: [{ ...item, checked: false, token: "new-token" }] }));
  const button = screen.getByRole("button", { name: "Sample: Target" });
  fireEvent.click(button);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.getAttribute("aria-busy")).toBe("true");
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Sample: Target" }));
  expect(invoke).toHaveBeenLastCalledWith(
    "plugin_tab_bar_execute",
    expect.objectContaining({ token: "new-token" }),
  );
  await act(async () => {
    finish();
    await Promise.resolve();
  });
});

it("keeps disabled controls distinct from running commands", () => {
  usePluginTabBar.setState({ items: [{ ...item, disabled: true }] });
  render(<TabBarContributions context={context} />);
  const button = screen.getByRole("button", { name: "Sample: Target" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.hasAttribute("aria-busy")).toBe(false);
  fireEvent.click(button);
  expect(invoke).not.toHaveBeenCalled();
});

it("dispatches a select value and renders status text without executing it", async () => {
  usePluginTabBar.setState({
    items: [
      {
        ...item,
        kind: "select",
        value: "local",
        options: [
          { value: "local", label: "Local" },
          { value: "remote", label: "Remote" },
        ],
      },
      { ...item, id: "status", kind: "text", title: "Ready", command: null },
    ],
  });
  render(<TabBarContributions context={context} />);
  fireEvent.click(screen.getByRole("button", { name: "Sample: Target" }));
  fireEvent.click(screen.getByRole("option", { name: "Remote" }));
  expect(invoke).toHaveBeenCalledWith(
    "plugin_tab_bar_execute",
    expect.objectContaining({ value: "remote" }),
  );
  expect(screen.getByText("Ready")).toBeTruthy();
  await act(() => Promise.resolve());
});
