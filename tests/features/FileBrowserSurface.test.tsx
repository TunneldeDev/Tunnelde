import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StrictMode, useEffect, useLayoutEffect } from "react";
import { observeFileBrowsers, readFileBrowser } from "@/lib/plugins/files/browser/data";
import { runFileBrowserAction } from "@/lib/plugins/files/browser/actions";
import "@/i18n/i18n";
import { FileBrowserSurface } from "@/features/sftp/FileBrowserSurface";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { FrontendFileBrowser, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import type { PluginInfo } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { UiResourceScope } from "@/lib/extensions/contracts/runtime/resources";

const plugin = {
  id: "files-ui",
  name: "Files UI",
  status: "running",
  fingerprint: "approved",
  runtime: "frontend",
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  permissions: ["ui.trusted", "fs.read", "sftp.read", "workspace.write"],
  views: [{ id: "files", title: "Files", kind: "component", provider: "fileBrowser" }],
} as PluginInfo;
const selected = { fileBrowser: { pluginId: plugin.id, viewId: "files" } };
const entry = {
  name: "file.txt",
  path: "/work/file.txt",
  isDir: false,
  isHidden: false,
  size: 1,
  modified: null,
  permissions: null,
};
const actions = { navigate: vi.fn(), refresh: vi.fn(), select: vi.fn(), open: vi.fn() };
let retained: FrontendFileBrowser;
const mounted = vi.fn(),
  unmounted = vi.fn();
function Rows() {
  useEffect(() => {
    mounted();
    return () => {
      unmounted();
    };
  }, []);
  return <input aria-label="retained row" defaultValue="draft" />;
}
function Provider({ fileBrowser }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = fileBrowser!;
  });
  const Entries = fileBrowser!.Entries;
  const page = fileBrowser!.read({ revision: fileBrowser!.snapshot.revision });
  return (
    <section aria-label="custom files">
      <span>{page.items[0]?.name}</span>
      <Entries />
    </section>
  );
}
const props = {
  paneId: "one",
  source: { kind: "local" as const },
  path: "/work",
  entries: [entry],
  selectedPaths: [],
  busy: false,
  error: null,
  suspended: false,
  actions,
};
beforeEach(() => {
  mockCommittedViewScopes();
  vi.clearAllMocks();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: false } }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function choose() {
  act(() => useSettings.setState((s) => ({ settings: { ...s.settings, uiProviders: selected } })));
}

it("publishes committed native browsers under StrictMode and retires frames on hide, source switch and close", async () => {
  const content = (
    suspended = false,
    source: FrontendFileBrowser["snapshot"]["source"] = props.source,
  ) => (
    <StrictMode>
      <FileBrowserSurface {...props} tabId="files-tab" source={source} suspended={suspended}>
        <Rows />
      </FileBrowserSurface>
    </StrictMode>
  );
  const ui = render(content());
  const first = await observeFileBrowsers({});
  if (!first.changed) throw new Error("expected metadata");
  const frame = first.snapshot.items[0]!;
  expect(frame).toMatchObject({ paneId: "one", tabId: "files-tab", suspended: false });
  expect(readFileBrowser({ paneId: "one", revision: frame.revision }).items).toHaveLength(1);
  ui.rerender(content(true));
  expect(() =>
    runFileBrowserAction({ paneId: "one", revision: frame.revision, action: "refresh" }),
  ).toThrow("changed");
  const hidden = await observeFileBrowsers({});
  if (!hidden.changed) throw new Error("expected metadata");
  expect(hidden.snapshot.items[0]).toMatchObject({ suspended: true, busy: true });
  expect(() =>
    runFileBrowserAction({
      paneId: "one",
      revision: hidden.snapshot.items[0]!.revision,
      action: "refresh",
    }),
  ).toThrow("busy");
  ui.rerender(content(false, { kind: "remote", sessionId: "new-session" }));
  const remote = await observeFileBrowsers({});
  if (!remote.changed) throw new Error("expected metadata");
  expect(remote.snapshot.items[0]?.source).toEqual({ kind: "remote", sessionId: "new-session" });
  ui.unmount();
  expect(() =>
    readFileBrowser({ paneId: "one", revision: remote.snapshot.items[0]!.revision }),
  ).toThrow("changed");
  expect(await observeFileBrowsers({})).toMatchObject({ changed: true, snapshot: { total: 0 } });
});

it("retains the scope on directory refresh but retires it on source or remote-session changes", () => {
  const scopes: UiResourceScope[] = [];
  vi.mocked(frontendRuntime.view).mockReturnValue(function Scoped(props: FrontendViewProps) {
    useEffect(() => {
      scopes.push(props.resources!);
    }, [props.resources]);
    return <Provider {...props} />;
  });
  choose();
  const content = (
    source = props.source as FrontendFileBrowser["snapshot"]["source"],
    path = "/work",
  ) => (
    <FileBrowserSurface {...props} source={source} path={path}>
      <Rows />
    </FileBrowserSurface>
  );
  const ui = render(content());
  const row = screen.getByLabelText("retained row");
  ui.rerender(content(props.source, "/other"));
  expect(scopes).toHaveLength(1);
  expect(scopes[0]!.signal.aborted).toBe(false);
  ui.rerender(content({ kind: "remote", sessionId: "one" }));
  expect(scopes).toHaveLength(2);
  expect(scopes[0]!.signal.aborted).toBe(true);
  ui.rerender(content({ kind: "remote", sessionId: "two" }));
  expect(scopes).toHaveLength(3);
  expect(scopes[1]!.signal.aborted).toBe(true);
  expect(scopes[2]!.signal.aborted).toBe(false);
  expect(screen.getByLabelText("retained row")).toBe(row);
  expect(mounted).toHaveBeenCalledOnce();
});

it("composes live host rows, preserves their DOM on restore and fences the old context", () => {
  render(
    <FileBrowserSurface {...props}>
      <Rows />
    </FileBrowserSurface>,
  );
  const row = screen.getByLabelText("retained row");
  fireEvent.change(row, { target: { value: "unsaved" } });
  choose();
  expect(screen.getByRole("region", { name: "custom files" }).contains(row)).toBe(true);
  expect(screen.getByText("file.txt")).toBeTruthy();
  retained.select([entry.path]);
  expect(actions.select).toHaveBeenCalledWith([entry.path]);
  const old = retained;
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(screen.getByLabelText("retained row")).toBe(row);
  expect(row).toHaveProperty("value", "unsaved");
  expect(() => old.refresh()).toThrow("viewUnavailable");
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});
it("rejects stale navigation after a pane revision, close, provider stop and restricted mode", () => {
  choose();
  const { rerender, unmount } = render(
    <FileBrowserSurface {...props}>
      <Rows />
    </FileBrowserSurface>,
  );
  const old = retained;
  rerender(
    <FileBrowserSurface {...props} path="/next">
      <Rows />
    </FileBrowserSurface>,
  );
  expect(() => old.navigate("/wrong")).toThrow("changed");
  const next = retained;
  act(() => usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] }));
  expect(() => next.refresh()).toThrow("viewUnavailable");
  expect(() => next.read({ revision: next.snapshot.revision })).toThrow("viewUnavailable");
  expect(screen.getByLabelText("retained row")).toBeTruthy();
  act(() => usePlugins.setState({ items: [plugin] }));
  const running = retained;
  act(() => usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: true } })));
  expect(() => running.select([])).toThrow("viewUnavailable");
  act(() => usePluginSecurity.setState((s) => ({ state: { ...s.state, restricted: false } })));
  const closing = retained;
  unmount();
  expect(() => closing.refresh()).toThrow("viewUnavailable");
});
it("keeps native rows available for inline edits and recovers after provider render failure", () => {
  choose();
  const { rerender } = render(
    <FileBrowserSurface {...props}>
      <Rows />
    </FileBrowserSurface>,
  );
  const old = retained;
  rerender(
    <FileBrowserSurface {...props} suspended>
      <Rows />
    </FileBrowserSurface>,
  );
  expect(screen.queryByRole("region", { name: "custom files" })).toBeNull();
  expect(screen.getByLabelText("retained row")).toBeTruthy();
  expect(() => old.refresh()).toThrow("viewUnavailable");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(() => {
    throw new Error("broken renderer");
  });
  rerender(
    <FileBrowserSurface {...props}>
      <Rows />
    </FileBrowserSurface>,
  );
  expect(screen.getByRole("alert").textContent).toContain("broken renderer");
  expect(screen.getByLabelText("retained row")).toBeTruthy();
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});

it("rejects duplicate host-list mounts and restores the same native row owner", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(({ fileBrowser }: FrontendViewProps) => {
    const Entries = fileBrowser!.Entries;
    return (
      <>
        <Entries />
        <Entries />
      </>
    );
  });
  choose();
  render(
    <FileBrowserSurface {...props}>
      <Rows />
    </FileBrowserSurface>,
  );
  expect(screen.getByRole("alert").textContent).toContain("mounted a host surface more than once");
  expect(screen.getByLabelText("retained row")).toBeTruthy();
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});
