import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePreview } from "@/features/sftp/FilePreview";
import { useFilePreview } from "@/store/filePreview";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { api } from "@/lib/api/ipc";
import { observeFilePreview, readFilePreviewProviders } from "@/lib/plugins/files/preview/data";
import { runFilePreviewAction } from "@/lib/plugins/files/preview/actions";
import { runFilePreviewRequest } from "@/app/plugins/filePreviewRequests";
import { liveFilePreview } from "@/lib/files/preview/registry";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import type { FrontendFilePreview } from "@/lib/extensions/contracts/files/preview/provider";
import type { FrontendViewProps } from "@/lib/extensions/contracts/frontend/views";
import { plugin } from "../fixtures/plugins";
import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import i18n from "@/i18n/i18n";
import { SidebarArea } from "@/components/layout/SidebarDock";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { previewPanelId } from "@/store/filePreview";
import { runWorkbenchCommand } from "@/lib/keyboard/actions";

vi.mock("@/features/terminal/TerminalPage", () => ({ TerminalPage: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string) => `preview://localhost/${id}`,
}));
vi.mock("@/lib/api/ipc", () => ({
  isTauri: () => false,
  api: {
    searchPreviewLocal: vi.fn(),
    sftpReadText: vi.fn(),
    filePreviewOpen: vi.fn(),
    filePreviewClose: vi.fn(),
  },
}));

const images = {
  ...plugin,
  id: "images",
  fingerprint: "v1",
  runtime: "theme" as const,
  filePreviews: [{ id: "image", name: "Images", renderer: "image" as const, extensions: ["png"] }],
};
function snapshot() {
  const observation = observeFilePreview({});
  if (!observation.changed || !observation.snapshot) throw new Error("missing committed preview");
  return observation.snapshot;
}
const action = (kind: "close" | "retry") => {
  const current = snapshot();
  return runFilePreviewAction({ id: current.id, revision: current.revision, action: kind });
};
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useFilePreview.getState().close();
  useFilePreview.setState({ presentation: "quickLook" });
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useNavigation.setState(useNavigation.getInitialState(), true);
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  usePlugins.setState({ items: [] });
  usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: false } }));
  vi.mocked(api.filePreviewOpen).mockImplementation(async (id, _provider, _path) => ({
    id,
    size: 5,
    renderer: "image",
  }));
  vi.mocked(api.filePreviewClose).mockResolvedValue();
  vi.mocked(api.searchPreviewLocal).mockResolvedValue("preview text");
  vi.mocked(api.sftpReadText).mockResolvedValue({ content: "remote preview", size: 14 });
});

function DockingShell() {
  return (
    <>
      <SidebarArea />
      <PaneLayout />
      <WorkspaceContents />
      <FilePreview />
    </>
  );
}

it("docks, repositions and undocks the same decoded renderer and native ticket", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().show("C:/photo.png");
  render(<DockingShell />);
  const image = await screen.findByRole("img", { name: "photo.png" });
  fireEvent.load(image);
  const before = snapshot();
  const oldContext = liveFilePreview(before.id, before.revision);
  fireEvent.click(screen.getByRole("button", { name: "Dock preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("img", { name: "photo.png" })).toBe(image);
  expect(snapshot()).toMatchObject({
    id: before.id,
    attemptId: before.attemptId,
    state: "ready",
    presentation: "docked",
  });
  expect(() => oldContext.dock()).toThrow("changed");
  const docked = snapshot();
  act(() => runFilePreviewAction({ id: docked.id, revision: docked.revision, action: "dock" }));
  expect(snapshot().revision).toBe(docked.revision);
  act(() => useWorkspace.getState().splitTab(previewPanelId, "column", "after", "root"));
  expect(screen.getByRole("img", { name: "photo.png" })).toBe(image);
  expect(api.filePreviewOpen).toHaveBeenCalledOnce();
  expect(api.filePreviewClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open in Quick Look" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("img", { name: "photo.png" })).toBe(image);
  expect(snapshot()).toMatchObject({
    id: before.id,
    attemptId: before.attemptId,
    state: "ready",
    presentation: "quickLook",
  });
  expect(api.filePreviewOpen).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(api.filePreviewClose).toHaveBeenCalledOnce();
});

it("closing the preview group releases resources and reopening retains the panel geometry", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().dock();
  useFilePreview.getState().show("C:/first.png");
  render(<DockingShell />);
  await screen.findByRole("img", { name: "first.png" });
  const workspace = useWorkspace.getState();
  const owner = workspace.panes.find((pane) => pane.tabIds.includes(previewPanelId))!;
  expect(workspace.layout.kind).toBe("split");
  if (workspace.layout.kind !== "split") throw new Error("missing split");
  act(() =>
    workspace.resizeSplit(workspace.layout.kind === "split" ? workspace.layout.id : "", 0.47),
  );
  const geometry = useWorkspace.getState().layout;
  act(() => useWorkspace.getState().closePane(owner.id));
  expect(useFilePreview.getState().file).toBeNull();
  expect(api.filePreviewClose).toHaveBeenCalledOnce();
  expect(observeFilePreview({})).toMatchObject({ snapshot: null });
  expect(
    document.querySelector('.sidebar-view:not([hidden]) [data-sidebar-slot="filePreview"]'),
  ).toBeNull();
  act(() => useFilePreview.getState().show("C:/second.png"));
  await screen.findByRole("img", { name: "second.png" });
  expect(useWorkspace.getState().layout).toEqual(geometry);
  expect(
    useWorkspace.getState().panes.find((pane) => pane.tabIds.includes(previewPanelId))?.id,
  ).toBe(owner.id);
  expect(useWorkspace.getState().tabs.filter((tab) => tab.id === previewPanelId)).toHaveLength(1);
});

it("a late media open cannot resurrect a closed docked preview", async () => {
  usePlugins.setState({ items: [images] });
  let finish!: () => void;
  vi.mocked(api.filePreviewOpen).mockImplementationOnce(
    (id) =>
      new Promise((resolve) => {
        finish = () => resolve({ id, renderer: "image", size: 5 });
      }),
  );
  useFilePreview.getState().dock();
  useFilePreview.getState().show("/slow.png", 0, 0, { kind: "remote", sessionId: "original" });
  render(<DockingShell />);
  await waitFor(() => expect(api.filePreviewOpen).toHaveBeenCalledOnce());
  act(() => useWorkspace.getState().close(previewPanelId));
  await act(async () => finish());
  expect(useFilePreview.getState().file).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
  expect(api.filePreviewClose).toHaveBeenCalledTimes(2);
  expect(useWorkspace.getState().tabs.find((tab) => tab.id === previewPanelId)?.hidden).toBe(true);
});

it("switching remote targets and revoking a renderer retires only its original resource", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().dock();
  useFilePreview.getState().show("/photo.png", 0, 0, { kind: "remote", sessionId: "one" });
  render(<DockingShell />);
  await screen.findByRole("img", { name: "photo.png" });
  const old = snapshot();
  act(() =>
    useFilePreview.getState().show("/photo.png", 0, 0, { kind: "remote", sessionId: "two" }),
  );
  await screen.findByRole("img", { name: "photo.png" });
  expect(api.filePreviewOpen).toHaveBeenLastCalledWith(
    expect.any(String),
    "images:image",
    "/photo.png",
    "two",
  );
  expect(api.filePreviewClose).toHaveBeenCalledOnce();
  expect(() =>
    runFilePreviewAction({ id: old.id, revision: old.revision, action: "undock" }),
  ).toThrow("changed");
  act(() => usePlugins.setState({ items: [] }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(snapshot()).toMatchObject({ presentation: "docked", state: "unavailable" });
  expect(api.filePreviewClose).toHaveBeenCalledTimes(2);
});

it("the command opens an empty preview panel without silently reopening a saved remote file", () => {
  render(<DockingShell />);
  act(() => expect(runWorkbenchCommand("preview.showPanel")).toBe(true));
  expect(screen.getByText(i18n.t("preview.panelHint"))).toBeTruthy();
  expect(useFilePreview.getState().file).toBeNull();
  expect(api.filePreviewOpen).not.toHaveBeenCalled();
  expect(api.sftpReadText).not.toHaveBeenCalled();
});
it("an obsolete panel-close effect cannot close a replacement activated during commit", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().dock();
  useFilePreview.getState().show("C:/old.png");
  useWorkspace.getState().close(previewPanelId);
  function ReplaceDuringCommit() {
    useLayoutEffect(() => {
      useFilePreview.getState().undock();
      useFilePreview.getState().show("C:/replacement.png");
    }, []);
    return null;
  }
  render(
    <>
      <DockingShell />
      <ReplaceDuringCommit />
    </>,
  );
  await screen.findByRole("img", { name: "replacement.png" });
  expect(useFilePreview.getState().file?.path).toBe("C:/replacement.png");
  expect(snapshot().presentation).toBe("quickLook");
});

afterEach(() => {
  cleanup();
  useFilePreview.getState().close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("publishes committed metadata only, waits for actual decoding, and keeps identity across language/theme changes", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().show("C:/photo.png");
  expect(observeFilePreview({})).toMatchObject({ changed: true, snapshot: null });
  render(<FilePreview />);
  const image = await screen.findByRole("img", { name: "photo.png" });
  const opening = snapshot();
  expect(opening).toMatchObject({
    state: "loading",
    source: { kind: "local" },
    presentation: "quickLook",
  });
  fireEvent.load(image);
  const ready = snapshot();
  expect(ready).toMatchObject({
    state: "ready",
    errorCode: null,
    id: opening.id,
    attemptId: opening.attemptId,
  });
  expect(ready.revision).not.toBe(opening.revision);
  const observation = observeFilePreview({});
  await act(async () => i18n.changeLanguage("zh-CN"));
  act(() => useSettings.setState((state) => ({ settings: { ...state.settings, theme: "dark" } })));
  expect(screen.getByRole("img", { name: "photo.png" })).toBe(image);
  expect(observeFilePreview({ revision: observation.revision })).toEqual({
    schemaVersion: 1,
    revision: observation.revision,
    changed: false,
  });
  expect(api.filePreviewOpen).toHaveBeenCalledOnce();
  expect(JSON.stringify(observation)).not.toMatch(/preview:\/\/|resource|content|ticket/);
  act(() => action("close"));
  expect(observeFilePreview({})).toMatchObject({ snapshot: null });
  expect(api.filePreviewClose).toHaveBeenCalled();
});

it("consumes an action revision immediately, retries the same target with a new attempt and fences old callbacks", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().show("C:/photo.png");
  render(<FilePreview />);
  const oldImage = await screen.findByRole("img", { name: "photo.png" });
  const before = snapshot(),
    retained = liveFilePreview(before.id, before.revision);
  fireEvent.error(oldImage);
  expect(snapshot()).toMatchObject({ state: "error", errorCode: "decodeFailed" });
  const failure = snapshot();
  act(() => {
    expect(action("retry")).toEqual({ schemaVersion: 1, accepted: true });
    expect(() =>
      runFilePreviewAction({ id: failure.id, revision: failure.revision, action: "retry" }),
    ).toThrow("changed");
    expect(() => retained.close()).toThrow("changed");
  });
  const nextImage = await screen.findByRole("img", { name: "photo.png" });
  expect(nextImage).not.toBe(oldImage);
  const next = snapshot();
  expect(next.id).toBe(before.id);
  expect(next.attemptId).not.toBe(before.attemptId);
  fireEvent.load(nextImage);
  fireEvent.error(oldImage);
  expect(snapshot().state).toBe("ready");
  act(() => useFilePreview.getState().show("C:/photo.png"));
  await screen.findByRole("img", { name: "photo.png" });
  expect(snapshot().id).not.toBe(before.id);
});

it("pages every matching provider, changes renderer attempts on selection and safely falls back after removal", async () => {
  usePlugins.setState({
    items: Array.from({ length: 40 }, (_, index) => ({
      ...images,
      id: `images-${String(index).padStart(2, "0")}`,
    })),
  });
  useFilePreview.getState().show("C:/photo.png");
  render(<FilePreview />);
  await screen.findByRole("img", { name: "photo.png" });
  const before = snapshot();
  const page = readFilePreviewProviders({
    id: before.id,
    revision: before.revision,
    offset: 32,
    limit: 8,
  });
  expect(page.total).toBe(40);
  expect(page.items).toHaveLength(8);
  expect(page.nextOffset).toBeNull();
  const chosen = page.items[7]!.id;
  act(() =>
    runFilePreviewAction({
      id: before.id,
      revision: before.revision,
      action: "selectProvider",
      providerId: chosen,
    }),
  );
  await screen.findByRole("img", { name: "photo.png" });
  expect(snapshot().providerId).toBe(chosen);
  expect(snapshot().attemptId).not.toBe(before.attemptId);
  expect(() => readFilePreviewProviders({ id: before.id, revision: before.revision })).toThrow(
    "changed",
  );
  act(() => usePlugins.setState({ items: [] }));
  expect(snapshot()).toMatchObject({
    state: "unavailable",
    errorCode: "rendererUnavailable",
    providerId: null,
    providerCount: 0,
  });
  expect(screen.getByRole("button", { name: "Find preview plugins" })).toBeTruthy();
});

it("keeps the full composite identity of maximum-length valid manifest renderer IDs", async () => {
  const pluginId = "p".repeat(64),
    rendererId = "r".repeat(64);
  usePlugins.setState({
    items: [
      { ...images, id: pluginId, filePreviews: [{ ...images.filePreviews[0]!, id: rendererId }] },
    ],
  });
  useFilePreview.getState().show("C:/photo.png");
  render(<FilePreview />);
  await screen.findByRole("img", { name: "photo.png" });
  const before = snapshot(),
    providerId = `${pluginId}:${rendererId}`;
  expect(before.providerId).toBe(providerId);
  expect(readFilePreviewProviders({ id: before.id, revision: before.revision }).items[0]!.id).toBe(
    providerId,
  );
  act(() =>
    runFilePreviewAction({
      id: before.id,
      revision: before.revision,
      action: "selectProvider",
      providerId,
    }),
  );
  await screen.findByRole("img", { name: "photo.png" });
  expect(snapshot().providerId).toBe(providerId);
});

it("invalidates the pending frame before a replacement renders, and does not accept denied/cancelled mutations", async () => {
  useFilePreview.getState().show("C:/a.txt");
  render(<FilePreview />);
  await screen.findByRole("textbox");
  const first = snapshot(),
    retained = liveFilePreview(first.id, first.revision);
  act(() => {
    useFilePreview
      .getState()
      .show("/remote.txt", 2, 3, { kind: "remote", sessionId: "ssh-explicit" });
    expect(() => retained.close()).toThrow("changed");
  });
  await screen.findByRole("textbox");
  const denied = vi.fn(async () => {
    throw new Error("requestCancelled");
  });
  await expect(
    runFilePreviewRequest(
      "filePreview.open",
      { source: { kind: "local" }, path: "C:/wrong.txt" },
      denied,
    ),
  ).rejects.toThrow("requestCancelled");
  expect(useFilePreview.getState().file).toMatchObject({
    path: "/remote.txt",
    source: { kind: "remote", sessionId: "ssh-explicit" },
  });
});

it("retains host renderer DOM across selected presentation changes and fences retained provider authority", async () => {
  mockCommittedViewScopes();
  const ui = {
    ...plugin,
    id: "preview-ui",
    runtime: "frontend" as const,
    status: "running" as const,
    frontend: { entry: "ui.mjs", sdk: "^0.1.0" },
    permissions: ["ui.trusted", "filePreview.read", "fs.read"],
    views: [
      {
        id: "preview",
        title: "Preview",
        kind: "component" as const,
        provider: "filePreview" as const,
      },
    ],
  };
  let retained: FrontendFilePreview | undefined;
  function Presentation({ filePreview }: FrontendViewProps) {
    useLayoutEffect(() => {
      retained = filePreview;
    }, [filePreview]);
    const Body = filePreview!.Body;
    return (
      <section data-testid="presentation">
        <Body />
      </section>
    );
  }
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Presentation);
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
  usePlugins.setState({ items: [images, ui] });
  useFilePreview.getState().show("C:/photo.png");
  render(<FilePreview />);
  const image = await screen.findByRole("img", { name: "photo.png" });
  act(() =>
    useSettings.setState((state) => ({
      settings: {
        ...state.settings,
        uiProviders: { filePreview: { pluginId: ui.id, viewId: "preview" } },
      },
    })),
  );
  expect(screen.getByTestId("presentation").contains(image)).toBe(true);
  fireEvent.load(image);
  await waitFor(() => expect(retained?.snapshot.state).toBe("ready"));
  expect(screen.getByRole("img", { name: "photo.png" })).toBe(image);
  expect(() => retained!.retry()).toThrow("permissionDenied");
  const old = retained!;
  act(() => usePlugins.setState({ items: [images, { ...ui, status: "stopped" }] }));
  expect(screen.getByRole("img", { name: "photo.png" })).toBe(image);
  expect(() => old.readProviders({ revision: old.snapshot.revision })).toThrow("viewUnavailable");
  expect(api.filePreviewOpen).toHaveBeenCalledOnce();
});

it("does not reveal a target that closed before React commits and releases a late native open", async () => {
  let finish!: (value: { id: string; size: number; renderer: "image" }) => void;
  vi.mocked(api.filePreviewOpen).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().show("C:/photo.png");
  render(<FilePreview />);
  await waitFor(() => expect(api.filePreviewOpen).toHaveBeenCalledOnce());
  const current = observeFilePreview({});
  act(() => {
    useFilePreview.getState().close();
    expect(observeFilePreview({ revision: current.revision })).toMatchObject({
      changed: true,
      snapshot: null,
    });
  });
  const ticketId = vi.mocked(api.filePreviewOpen).mock.calls[0]![0];
  await act(async () => finish({ id: ticketId, size: 5, renderer: "image" }));
  expect(api.filePreviewClose).toHaveBeenCalledTimes(2);
  expect(api.filePreviewClose).toHaveBeenLastCalledWith(ticketId);
  expect(screen.queryByRole("img", { name: "photo.png" })).toBeNull();
});

it("creates a fresh attempt after renderer fingerprint replacement, including StrictMode cleanup", async () => {
  usePlugins.setState({ items: [images] });
  useFilePreview.getState().show("C:/photo.png");
  render(
    <StrictMode>
      <FilePreview />
    </StrictMode>,
  );
  const image = await screen.findByRole("img", { name: "photo.png" });
  fireEvent.load(image);
  const before = snapshot();
  act(() => usePlugins.setState({ items: [{ ...images, fingerprint: "v2" }] }));
  const replaced = await screen.findByRole("img", { name: "photo.png" });
  expect(replaced).not.toBe(image);
  expect(snapshot().attemptId).not.toBe(before.attemptId);
  expect(snapshot().id).toBe(before.id);
  expect(snapshot().state).toBe("loading");
  fireEvent.error(image);
  fireEvent.load(replaced);
  expect(snapshot().state).toBe("ready");
});

it.each(["missing", "duplicate", "throwing"] as const)(
  "handles a %s provider Body without losing the host renderer",
  async (mode) => {
    mockCommittedViewScopes();
    const ui = {
      ...plugin,
      id: "preview-ui",
      runtime: "frontend" as const,
      status: "running" as const,
      frontend: { entry: "ui.mjs", sdk: "^0.1.0" },
      permissions: ["ui.trusted", "filePreview.read", "fs.read"],
      views: [
        {
          id: "preview",
          title: "Preview",
          kind: "component" as const,
          provider: "filePreview" as const,
        },
      ],
    };
    function Presentation({ filePreview }: FrontendViewProps) {
      const Body = filePreview!.Body;
      if (mode === "throwing") throw Error("broken presentation");
      return mode === "missing" ? (
        <span>Custom metadata only</span>
      ) : (
        <>
          <Body />
          <Body />
        </>
      );
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(frontendRuntime, "view").mockReturnValue(Presentation);
    vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
    usePlugins.setState({ items: [images, ui] });
    useFilePreview.getState().show("C:/photo.png");
    render(<FilePreview />);
    const image = await screen.findByRole("img", { name: "photo.png" });
    fireEvent.load(image);
    act(() =>
      useSettings.setState((state) => ({
        settings: {
          ...state.settings,
          uiProviders: { filePreview: { pluginId: ui.id, viewId: "preview" } },
        },
      })),
    );
    if (mode === "missing") {
      expect(screen.getByText("Custom metadata only")).toBeTruthy();
      expect(screen.queryByRole("img", { name: "photo.png" })).toBeNull();
      act(() =>
        useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } })),
      );
    }
    await waitFor(() => expect(screen.getByRole("img", { name: "photo.png" })).toBe(image));
    expect(snapshot().state).toBe("ready");
    expect(api.filePreviewOpen).toHaveBeenCalledOnce();
  },
);

it("falls back from a local-only presentation for remote targets and fences retained Body after revocation", async () => {
  mockCommittedViewScopes();
  const ui = {
    ...plugin,
    id: "preview-ui",
    runtime: "frontend" as const,
    status: "running" as const,
    frontend: { entry: "ui.mjs", sdk: "^0.1.0" },
    permissions: ["ui.trusted", "filePreview.read", "fs.read", "filePreview.write"],
    views: [
      {
        id: "preview",
        title: "Preview",
        kind: "component" as const,
        provider: "filePreview" as const,
      },
    ],
  };
  let retained!: FrontendFilePreview;
  function Presentation({ filePreview }: FrontendViewProps) {
    useLayoutEffect(() => {
      retained = filePreview!;
    }, [filePreview]);
    const Body = filePreview!.Body;
    return (
      <section data-testid="local-only">
        <Body />
      </section>
    );
  }
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Presentation);
  vi.spyOn(frontendRuntime, "ensure").mockResolvedValue();
  usePlugins.setState({ items: [ui] });
  useSettings.setState((state) => ({
    settings: {
      ...state.settings,
      uiProviders: { filePreview: { pluginId: ui.id, viewId: "preview" } },
    },
  }));
  useFilePreview.getState().show("C:/a.txt");
  render(<FilePreview />);
  await screen.findByRole("textbox");
  const old = retained;
  act(() =>
    usePlugins.setState({
      items: [{ ...ui, permissions: ["ui.trusted", "filePreview.read", "sftp.read"] }],
    }),
  );
  expect(() => old.retry()).toThrow("viewUnavailable");
  expect(() => (old.Body as () => unknown)()).toThrow("viewUnavailable");
  act(() => {
    usePlugins.setState({ items: [ui] });
    useFilePreview.getState().show("/a.txt", 0, 0, { kind: "remote", sessionId: "peer" });
  });
  await screen.findByRole("textbox");
  expect(screen.queryByTestId("local-only")).toBeNull();
  expect(snapshot().source).toEqual({ kind: "remote", sessionId: "peer" });
});
