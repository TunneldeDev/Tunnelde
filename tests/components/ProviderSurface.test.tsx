import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useState, useEffect } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createWorkbenchSurfaces } from "@/components/layout/WorkbenchSurfaces";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { PluginInfo } from "@/lib/api/types";
import type { FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import { uiProviders } from "@/lib/extensions/providers";
import * as ipc from "@/lib/api/ipc";

const plugin = {
  id: "layout",
  name: "Layout",
  runtime: "frontend",
  status: "running",
  fingerprint: "approved",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "hosts.read"],
  views: [{ id: "layout", title: "Layout", kind: "component", provider: "workbench" }],
} as PluginInfo;
const selected = { workbench: { pluginId: "layout", viewId: "layout" } } as const;
const mounted = vi.fn();
const unmounted = vi.fn();
function Page() {
  useEffect(() => {
    mounted();
    return () => {
      unmounted();
    };
  }, []);
  return <textarea aria-label="Retained editor" defaultValue="draft" />;
}
function Layout({ workbench }: FrontendViewProps) {
  const Workspace = workbench!.Workspace;
  return (
    <section data-testid="custom-layout">
      <Workspace />
    </section>
  );
}
function Fixture() {
  const [surfaces] = useState(createWorkbenchSurfaces);
  const Workspace = surfaces.slots.Workspace;
  return (
    <>
      <ProviderSurface
        target="workbench"
        slots={surfaces.slots}
        validate={surfaces.hasWorkspace}
        subscribe={surfaces.subscribe}
      >
        <section data-testid="built-in">
          <Workspace />
        </section>
      </ProviderSurface>
      {createPortal(<Page />, surfaces.container("workspace"))}
    </>
  );
}
beforeEach(() => {
  mockCommittedViewScopes();
  mounted.mockClear();
  unmounted.mockClear();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: false } }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Layout);
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("selects no provider implicitly and keeps the same editor DOM and owner across selection and restore", async () => {
  render(<Fixture />);
  const input = screen.getByLabelText("Retained editor");
  fireEvent.change(input, { target: { value: "unsaved text" } });
  act(() => {
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } }));
  });
  expect(screen.getByTestId("custom-layout").contains(input)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  await waitFor(() => expect(screen.getByTestId("built-in").contains(input)).toBe(true));
  expect((input as HTMLTextAreaElement).value).toBe("unsaved text");
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});

it("restores the built-in layout without losing content on stop, restricted mode and removal", () => {
  render(<Fixture />);
  const input = screen.getByLabelText("Retained editor");
  const select = () =>
    act(() =>
      useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
    );
  select();
  act(() => usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] }));
  expect(screen.getByTestId("built-in").contains(input)).toBe(true);
  act(() => usePlugins.setState({ items: [plugin] }));
  expect(screen.getByTestId("custom-layout").contains(input)).toBe(true);
  act(() =>
    usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: true } })),
  );
  expect(screen.getByTestId("built-in").contains(input)).toBe(true);
  act(() =>
    usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: false } })),
  );
  act(() => usePlugins.setState({ items: [] }));
  expect(screen.getByTestId("built-in").contains(input)).toBe(true);
  expect(mounted).toHaveBeenCalledOnce();
});

it("falls back when native grants are revoked and rejects an old renderer after a fingerprint change", async () => {
  vi.spyOn(ipc, "isTauri").mockReturnValue(true);
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { [plugin.id]: plugin.permissions } },
  }));
  vi.mocked(frontendRuntime.view).mockImplementation((_pluginId, _viewId, fingerprint) =>
    fingerprint === "approved" ? Layout : undefined,
  );
  render(<Fixture />);
  const input = screen.getByLabelText("Retained editor");
  act(() =>
    useSettings.setState((state) => ({
      settings: { ...state.settings, uiProviders: selected },
    })),
  );
  expect(screen.getByTestId("custom-layout").contains(input)).toBe(true);
  act(() => usePluginSecurity.setState((state) => ({ state: { ...state.state, grants: {} } })));
  expect(screen.getByTestId("built-in").contains(input)).toBe(true);
  act(() =>
    usePluginSecurity.setState((state) => ({
      state: { ...state.state, grants: { [plugin.id]: plugin.permissions } },
    })),
  );
  expect(screen.getByTestId("custom-layout").contains(input)).toBe(true);
  await act(async () => usePlugins.setState({ items: [{ ...plugin, fingerprint: "changed" }] }));
  expect(screen.getByTestId("built-in").contains(input)).toBe(true);
  expect(frontendRuntime.view).toHaveBeenCalledWith(plugin.id, "layout", "changed");
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});

it("falls back after a rendering error and does not retry the broken provider on unrelated updates", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(() => {
    throw new Error("render failed");
  });
  render(<Fixture />);
  const input = screen.getByLabelText("Retained editor");
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
  );
  expect(screen.getByTestId("built-in").contains(input)).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("render failed");
  act(() =>
    useSettings.setState((state) => ({
      settings: { ...state.settings, rightPanel: true, uiProviders: structuredClone(selected) },
    })),
  );
  expect(screen.getByRole("alert").textContent).toContain("render failed");
  error.mockRestore();
});

it("rejects missing and duplicate workspace surfaces", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(() => <div>Missing workspace</div>);
  const result = render(<Fixture />);
  const input = screen.getByLabelText("Retained editor");
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
  );
  await waitFor(() => expect(screen.getByTestId("built-in").contains(input)).toBe(true));
  result.unmount();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  vi.mocked(frontendRuntime.view).mockReturnValue(({ workbench }) => {
    const Workspace = workbench!.Workspace;
    return (
      <>
        <Workspace />
        <Workspace />
      </>
    );
  });
  render(<Fixture />);
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
  );
  await waitFor(() => expect(screen.getByTestId("built-in")).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("duplicateSurface");
});

it("restores the workspace if a provider removes its mount after the initial render", async () => {
  vi.mocked(frontendRuntime.view).mockReturnValue(({ workbench }) => {
    const Workspace = workbench!.Workspace;
    const [show, setShow] = useState(true);
    return (
      <>
        <button onClick={() => setShow(false)}>Remove workspace</button>
        {show && <Workspace />}
      </>
    );
  });
  render(<Fixture />);
  const input = screen.getByLabelText("Retained editor");
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove workspace" }));
  await waitFor(() => expect(screen.getByTestId("built-in").contains(input)).toBe(true));
  expect(unmounted).not.toHaveBeenCalled();
});

it("latches an activation failure and leaves the built-in layout usable", async () => {
  vi.mocked(frontendRuntime.view).mockReturnValue(undefined);
  vi.mocked(frontendRuntime.ensure).mockRejectedValue(new Error("activation failed"));
  render(<Fixture />);
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selected } })),
  );
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("activation failed"));
  expect(frontendRuntime.ensure).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Retained editor")).toBeTruthy();
});

it("rejects undeclared providers and does not expose host data without hosts.read", () => {
  expect(uiProviders([{ ...plugin, frontend: undefined }], "workbench")).toEqual([]);
  expect(
    uiProviders(
      [
        {
          ...plugin,
          views: [{ ...plugin.views[0]!, provider: "hostList" }],
          permissions: ["ui.trusted"],
        },
      ],
      "hostList",
    ),
  ).toEqual([]);
  expect(uiProviders([plugin], "workbench")).toHaveLength(1);
});
