import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fsMock } = vi.hoisted(() => ({
  fsMock: {
    list: vi.fn(),
    mkdir: vi.fn(),
    createFile: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    copy: vi.fn(),
    transfer: vi.fn(),
    openLocal: vi.fn(),
    home: vi.fn(),
    readText: vi.fn(),
    writeText: vi.fn(),
  },
}));

vi.mock("@/lib/files/fs", () => ({
  fs: fsMock,
  LOCAL_SOURCE: { kind: "local" },
  sourceKey: (source: { kind: string; sessionId?: string }) =>
    source.kind === "local" ? "local" : `remote:${source.sessionId}`,
  canEdit: () => false,
}));

import "@/i18n/i18n";
import { SftpPage } from "@/features/sftp/SftpPage";
import type { FileEntry, FsSource, SshSession } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useTransfers } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";
import { useFileClipboard } from "@/store/fileClipboard";
import { useFilePreview } from "@/store/filePreview";
import { DRAG_MIME } from "@/lib/files/dnd";
import { api } from "@/lib/api/ipc";
import { useContextMenu } from "@/store/contextMenu";
import { usePlugins } from "@/store/plugins";
import { plugin } from "../fixtures/plugins";
import * as clipboard from "@/lib/session/clipboard";
import * as mountedMenu from "@/lib/plugins/mountFileMenu";
import { domainEvents } from "@/lib/events/domain";

const session: SshSession = {
  id: "session-1",
  hostId: "host-1",
  title: "web-01",
  address: "root@10.0.0.5:22",
  cols: 120,
  rows: 32,
  connectedAt: 1,
};

const localListing = {
  path: "C:\\work",
  entries: [
    {
      name: "notes.txt",
      path: "C:\\work\\notes.txt",
      isDir: false,
      isHidden: false,
      size: 12,
      modified: null,
      permissions: null,
    },
    {
      name: "src",
      path: "C:\\work\\src",
      isDir: true,
      isHidden: false,
      size: 0,
      modified: null,
      permissions: null,
    },
  ],
};

const remoteListing = {
  path: "/srv/app",
  entries: [
    {
      name: "readme.md",
      path: "/srv/app/readme.md",
      isDir: false,
      isHidden: false,
      size: 20,
      modified: null,
      permissions: null,
    },
  ],
};

const listingFor = (source: FsSource) => (source.kind === "local" ? localListing : remoteListing);

beforeEach(() => {
  localStorage.clear();
  fsMock.list.mockReset();
  fsMock.rename.mockReset().mockResolvedValue(undefined);
  fsMock.createFile.mockReset().mockResolvedValue(undefined);
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  fsMock.transfer.mockReset().mockResolvedValue("transfer-1");
  fsMock.openLocal.mockReset().mockResolvedValue(undefined);
  fsMock.copy.mockReset().mockResolvedValue(undefined);
  fsMock.remove.mockReset().mockResolvedValue(undefined);
  fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) => {
    const listing = listingFor(source);
    return path ? { ...listing, path } : listing;
  });

  usePlugins.setState({ items: [] });
  useSsh.setState({ sessions: [session] });
  useHosts.setState({ hosts: [] });
  useDialogs.setState({ confirm: vi.fn(), openConnect: vi.fn() });
  useWorkspace.setState({ openEditor: vi.fn(), openLocalEditor: vi.fn() });
  useTransfers.setState({ items: [] });
  useFileClipboard.setState({ clip: null });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, preloadDirs: false } });
});

function openPath(index = 0): HTMLInputElement {
  const pane = document.querySelectorAll<HTMLElement>(".sftp-pane")[index]!;
  const existing = within(pane).queryByRole("textbox", { name: "Path" });
  if (existing) return existing as HTMLInputElement;
  fireEvent.click(within(pane).getByRole("button", { name: "Edit path" }));
  return within(pane).getByRole("textbox", { name: "Path" }) as HTMLInputElement;
}
function currentPath(index = 0): string | null {
  const pane = document.querySelectorAll(".sftp-pane")[index]!;
  return pane.querySelector('[aria-current="location"]')?.getAttribute("title") ?? null;
}

function resizePointer(type: string, clientX: number, pointerId = 1, button = 0) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    button,
    buttons: type === "pointermove" ? 1 : 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

describe("SftpPage", () => {
  it("records the current local path of a standalone panel for workspace restoration", async () => {
    const filePane = {
      source: { kind: "local" as const },
      path: "C:\\work",
      ownerSessionId: "session-1",
    };
    useWorkspace.setState({
      tabs: [
        {
          id: "files:test",
          kind: "sftp",
          title: "This computer",
          hostId: null,
          pinned: false,
          filePane,
        },
      ],
    });
    render(
      <SftpPage sessionId="session-1" single={filePane} tabId="files:test" scopeId="files:test" />,
    );
    await screen.findByText("src");
    fireEvent.doubleClick(screen.getByText("src"));
    await waitFor(() =>
      expect(useWorkspace.getState().tabs[0]?.filePane?.path).toBe("C:\\work\\src"),
    );
  });

  it("preserves a detached remote panel and its path when its session disconnects", async () => {
    const filePane = {
      source: { kind: "remote" as const, sessionId: session.id },
      path: "/srv/app",
      ownerSessionId: session.id,
      remoteIdentity: { hostId: session.hostId, address: session.address },
    };
    useWorkspace.setState({
      tabs: [
        {
          id: "files:offline",
          kind: "sftp",
          title: session.title,
          hostId: null,
          pinned: false,
          filePane,
        },
      ],
    });
    render(
      <SftpPage
        sessionId={session.id}
        single={filePane}
        tabId="files:offline"
        scopeId="files:offline"
      />,
    );
    await screen.findByText("readme.md");
    act(() => useSsh.setState({ sessions: [] }));
    await waitFor(() =>
      expect(useWorkspace.getState().tabs[0]?.filePane).toMatchObject({
        offline: true,
        path: "/srv/app",
        remoteIdentity: filePane.remoteIdentity,
      }),
    );
    expect(useWorkspace.getState().tabs[0]?.title).toBe(session.title);
  });

  it("does not persist an old local panel after switching it to a remote source", async () => {
    const filePane = {
      source: { kind: "local" as const },
      path: "C:\\work",
      ownerSessionId: "session-1",
    };
    useWorkspace.setState({
      tabs: [
        {
          id: "files:test",
          kind: "sftp",
          title: "This computer",
          hostId: null,
          pinned: false,
          filePane,
        },
      ],
    });
    render(
      <SftpPage sessionId="session-1" single={filePane} tabId="files:test" scopeId="files:test" />,
    );
    await screen.findByText("src");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Source" })).getByRole("option", {
        name: "web-01",
      }),
    );
    expect(useWorkspace.getState().tabs[0]?.filePane?.source).toEqual({
      kind: "remote",
      sessionId: "session-1",
    });
    await screen.findByText("readme.md");
  });
  it("moves a panel out and retains the other panel in the original tab", async () => {
    const original = {
      id: "sftp:session-1",
      kind: "sftp" as const,
      title: "web-01",
      hostId: "host-1",
      pinned: false,
    };
    useWorkspace.setState({
      tabs: [original],
      panes: [{ id: "test-pane", tabIds: [original.id], activeId: original.id }],
      activePaneId: "test-pane",
      activeId: original.id,
      split: null,
      layout: { kind: "pane", paneId: "test-pane" },
    });
    render(<SftpPage sessionId="session-1" tabId={original.id} />);
    await screen.findByText("readme.md");
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getAllByRole("button", { name: "Open as an independent panel" })[0]!);
    const tabs = useWorkspace.getState().tabs;
    const retained = tabs.find((tab) => tab.id === original.id);
    const detached = tabs.find((tab) => tab.id !== original.id);
    expect(retained?.filePane?.source).toEqual({ kind: "remote", sessionId: "session-1" });
    expect(retained?.filePane?.path).toBe("/srv/app");
    expect(detached?.filePane?.source).toEqual({ kind: "local" });
    expect(detached?.filePane?.path).toBe("C:\\work");
    expect(useWorkspace.getState().panes).toHaveLength(2);
  });
  it("independently configures visible columns and reorders headers", async () => {
    const { container } = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const panes = container.querySelectorAll<HTMLElement>(".sftp-pane");
    const local = panes[0]!;
    const remote = panes[1]!;
    fireEvent.click(within(local).getByRole("button", { name: "View options" }));
    const menuItem = screen.getByRole("menuitemcheckbox", { name: /Show column.*Type/i });
    fireEvent.click(menuItem);
    expect(local.querySelector(".sftp-columns__type")).toBeNull();
    expect(remote.querySelector(".sftp-columns__type")).toBeTruthy();
    const data = new Map<string, string>();
    const transfer = {
      types: ["application/x-tunnelde-file-column"],
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      effectAllowed: "move",
    };
    fireEvent.dragStart(local.querySelector(".sftp-columns__size")!, { dataTransfer: transfer });
    fireEvent.drop(local.querySelector(".sftp-columns__name")!, { dataTransfer: transfer });
    expect([...local.querySelectorAll(".sftp-columns th")].map((el) => el.className)).toEqual([
      "sftp-columns__size",
      "sftp-columns__name",
      "sftp-columns__modified",
    ]);
    fireEvent.dragStart(local.querySelector(".sftp-columns__size")!, { dataTransfer: transfer });
    fireEvent.drop(local.querySelector(".sftp-columns__size")!, { dataTransfer: transfer });
    expect([...local.querySelectorAll(".sftp-columns th")].map((el) => el.className)).toEqual([
      "sftp-columns__size",
      "sftp-columns__name",
      "sftp-columns__modified",
    ]);
  });

  it("resizes only the owning pointer, keeps concurrent column preferences and persists the release pixel", async () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const pane = document.querySelector<HTMLElement>(".sftp-pane")!;
    const name = within(pane).getByRole("separator", { name: "File sorting: Name" });
    fireEvent(name, resizePointer("pointerdown", 100, 1, 2));
    fireEvent(window, resizePointer("pointerup", 400));
    expect(name.getAttribute("aria-valuenow")).toBe("220");
    fireEvent(name, resizePointer("pointerdown", 100));
    fireEvent(window, resizePointer("pointermove", 400, 2));
    fireEvent(window, resizePointer("pointerup", 400, 2));
    fireEvent(window, resizePointer("pointercancel", 400, 2));
    expect(name.getAttribute("aria-valuenow")).toBe("220");
    for (let x = 101; x <= 150; x++) fireEvent(window, resizePointer("pointermove", x));
    expect(frame).toHaveBeenCalledOnce();
    act(() => frame.mock.calls[0]![0](0));
    expect(name.getAttribute("aria-valuenow")).toBe("270");
    expect(pane.style.getPropertyValue("--sftp-columns")).toBe("18px 246px 90px 90px 150px");
    fireEvent.keyDown(within(pane).getByRole("separator", { name: "File sorting: Size" }), {
      key: "ArrowRight",
    });
    fireEvent(window, resizePointer("pointerup", 180.4));
    expect(pane.style.getPropertyValue("--sftp-columns")).toBe("18px 276px 90px 100px 150px");
    view.unmount();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    expect(
      document.querySelector<HTMLElement>(".sftp-pane")!.style.getPropertyValue("--sftp-columns"),
    ).toBe("18px 276px 90px 100px 150px");
  });

  it("cancels only the drag preview while retaining another column's keyboard adjustment", async () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const pane = document.querySelector<HTMLElement>(".sftp-pane")!;
    const name = within(pane).getByRole("separator", { name: "File sorting: Name" });
    fireEvent(name, resizePointer("pointerdown", 100));
    fireEvent(window, resizePointer("pointermove", 150));
    act(() => frame.mock.calls[0]![0](0));
    fireEvent.keyDown(within(pane).getByRole("separator", { name: "File sorting: Size" }), {
      key: "ArrowRight",
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pane.style.getPropertyValue("--sftp-columns")).toBe("18px 196px 90px 100px 150px");
    expect(name.getAttribute("aria-valuenow")).toBe("220");
  });

  it.each(["pointercancel", "Escape", "blur", "unmount"])(
    "discards an unfinished column resize on %s and ignores its later release",
    async (reason) => {
      const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
      const view = render(<SftpPage sessionId="session-1" />);
      await screen.findByText("notes.txt");
      const pane = document.querySelector<HTMLElement>(".sftp-pane")!;
      const handle = within(pane).getByRole("separator", { name: "File sorting: Name" });
      const before = pane.style.getPropertyValue("--sftp-columns");
      const minimum = pane.style.getPropertyValue("--sftp-min-width");
      fireEvent(handle, resizePointer("pointerdown", 100));
      fireEvent(window, resizePointer("pointermove", 150));
      act(() => frame.mock.calls[0]![0](0));
      expect(handle.getAttribute("aria-valuenow")).toBe("270");
      if (reason === "unmount") view.unmount();
      else if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (reason === "blur") fireEvent(window, new Event("blur"));
      else fireEvent(window, resizePointer(reason, 150));
      expect(pane.style.getPropertyValue("--sftp-columns")).toBe(before);
      expect(pane.style.getPropertyValue("--sftp-min-width")).toBe(minimum);
      expect(handle.getAttribute("aria-valuenow")).toBe("220");
      fireEvent(window, resizePointer("pointerup", 200));
      if (reason !== "unmount") view.unmount();
      render(<SftpPage sessionId="session-1" />);
      await screen.findByText("notes.txt");
      expect(
        document.querySelector<HTMLElement>(".sftp-pane")!.style.getPropertyValue("--sftp-columns"),
      ).toBe(before);
    },
  );

  it("uses macOS file shortcuts without deleting while typing", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      render(<SftpPage sessionId="session-1" />);
      fireEvent.click(await screen.findByText("notes.txt"));
      const local = screen.getAllByRole("listbox")[0]!;
      fireEvent.keyDown(local, { key: "Backspace" });
      expect(useDialogs.getState().confirm).not.toHaveBeenCalled();
      fireEvent.keyDown(local, { key: "Backspace", metaKey: true });
      expect(useDialogs.getState().confirm).toHaveBeenCalledOnce();
      expect(fsMock.remove).not.toHaveBeenCalled();
      fireEvent.keyDown(local, { key: "Enter" });
      const input = await screen.findByDisplayValue("notes.txt");
      fireEvent.keyDown(input, { key: "Backspace", metaKey: true });
      expect(useDialogs.getState().confirm).toHaveBeenCalledOnce();
    } finally {
      platform.mockRestore();
    }
  });
  it("resets hidden, reordered and resized columns only in the chosen pane and persists the reset", async () => {
    const { unmount } = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const pane = document.querySelector<HTMLElement>(".sftp-pane")!;
    fireEvent.keyDown(within(pane).getByRole("separator", { name: "File sorting: Name" }), {
      key: "ArrowRight",
    });
    fireEvent.click(within(pane).getByRole("button", { name: "View options" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Show column: Type" }));
    const data = new Map<string, string>();
    const transfer = {
      types: ["application/x-tunnelde-file-column"],
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? "",
    };
    fireEvent.dragStart(pane.querySelector(".sftp-columns__size")!, { dataTransfer: transfer });
    fireEvent.drop(pane.querySelector(".sftp-columns__name")!, { dataTransfer: transfer });
    expect(pane.querySelector("th")?.className).toBe("sftp-columns__size");
    expect(pane.style.getPropertyValue("--sftp-columns")).toContain("206px");
    fireEvent.click(within(pane).getByRole("button", { name: "View options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset panel view" }));
    expect(pane.style.getPropertyValue("--sftp-columns")).toBe("18px 196px 90px 90px 150px");
    expect([...pane.querySelectorAll("th")].map((entry) => entry.className)).toEqual([
      "sftp-columns__name",
      "sftp-columns__type",
      "sftp-columns__size",
      "sftp-columns__modified",
    ]);
    unmount();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    expect(
      document.querySelector<HTMLElement>(".sftp-pane")!.style.getPropertyValue("--sftp-columns"),
    ).toBe("18px 196px 90px 90px 150px");
  });

  it.each(["Enter", "Escape"])(
    "returns path %s to the same pane's keyboard navigation",
    async (key) => {
      render(<SftpPage sessionId="session-1" />);
      await screen.findByText("readme.md");
      const input = openPath(1);
      fireEvent.keyDown(input, { key });
      const remote = screen.getAllByRole("listbox")[1]!;
      const proxy = within(remote).getByRole("textbox", {
        name: "Type to select a file or folder",
      });
      expect(document.activeElement).toBe(proxy);
      await waitFor(() => expect(remote.getAttribute("aria-busy")).toBe("false"));
      fireEvent.keyDown(proxy, { key: "Home" });
      expect(within(remote).getByRole("option", { selected: true }).textContent).toContain(
        "readme.md",
      );
    },
  );

  it.each(["rename", "file", "folder"] as const)(
    "returns cancelled %s to keyboard navigation without stealing focus on blur",
    async (operation) => {
      render(<SftpPage sessionId="session-1" />);
      fireEvent.click(await screen.findByText("notes.txt"));
      const local = screen.getAllByRole("listbox")[0]!;
      const start = () => {
        if (operation === "rename") fireEvent.keyDown(local, { key: "F2" });
        else
          fireEvent.click(
            screen.getAllByRole("button", {
              name: operation === "file" ? "New file" : "New folder",
            })[0]!,
          );
      };
      start();
      const input = local.querySelector<HTMLInputElement>(".sftp-row input")!;
      expect(document.activeElement).toBe(input);
      fireEvent.keyDown(input, { key: "Escape" });
      const proxy = within(local).getByRole("textbox", { name: "Type to select a file or folder" });
      expect(document.activeElement).toBe(proxy);
      fireEvent.keyDown(proxy, { key: "Home" });
      expect(within(local).getByRole("option", { selected: true }).textContent).toContain("src");
      start();
      const remote = screen.getAllByRole("listbox")[1]!;
      act(() => remote.focus());
      expect(local.querySelector(".sftp-row input")).toBeNull();
      expect(document.activeElement).toBe(
        within(remote).getByRole("textbox", { name: "Type to select a file or folder" }),
      );
    },
  );

  it.each(["rename", "create"] as const)(
    "keeps list focus after an unchanged %s",
    async (operation) => {
      render(<SftpPage sessionId="session-1" />);
      fireEvent.click(await screen.findByText("notes.txt"));
      const local = screen.getAllByRole("listbox")[0]!;
      if (operation === "rename") fireEvent.keyDown(local, { key: "F2" });
      else fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
      fireEvent.keyDown(local.querySelector(".sftp-row input")!, { key: "Enter" });
      expect(document.activeElement).toBe(
        within(local).getByRole("textbox", { name: "Type to select a file or folder" }),
      );
      expect(fsMock.rename).not.toHaveBeenCalled();
      expect(fsMock.createFile).not.toHaveBeenCalled();
    },
  );
  it("opens local text inside Tunnelde and offers the system application separately", async () => {
    render(<SftpPage sessionId="session-1" />);
    const file = await screen.findByText("notes.txt");
    fireEvent.doubleClick(file);
    expect(useWorkspace.getState().openLocalEditor).toHaveBeenCalledWith("C:\\work\\notes.txt");
    expect(fsMock.openLocal).not.toHaveBeenCalled();
    fireEvent.contextMenu(file);
    const item = useContextMenu
      .getState()
      .menu?.items.find((entry) => entry.label === "Open with system application");
    expect(item).toBeTruthy();
    item!.onSelect();
    expect(fsMock.openLocal).toHaveBeenCalledWith("C:\\work\\notes.txt");
  });

  it("offers a contributed action only on matching remote entries", async () => {
    usePlugins.setState({
      items: [
        {
          ...plugin,
          id: "file-tool",
          name: "File Tool",
          permissions: ["sftp.read"],
          commands: [
            {
              id: "inspect",
              title: "Inspect",
              fileMenu: { sources: ["remote"], kinds: ["file"], extensions: ["md"] },
            },
          ],
        },
      ],
    });
    render(<SftpPage sessionId="session-1" />);
    fireEvent.contextMenu(await screen.findByText("notes.txt"));
    expect(
      useContextMenu.getState().menu?.items.some((item) => item.label === "File Tool: Inspect"),
    ).toBe(false);
    fireEvent.contextMenu(screen.getByText("readme.md"));
    expect(
      useContextMenu.getState().menu?.items.some((item) => item.label === "File Tool: Inspect"),
    ).toBe(true);
  });

  it("adds a mounted-file action only to the menu that requested it", async () => {
    let finish!: () => void;
    const discover = vi.spyOn(mountedMenu, "discoverMountedFileActions").mockImplementationOnce(
      (_session, _path, onAction) =>
        new Promise((resolve) => {
          finish = () => {
            onAction?.(action);
            resolve([action]);
          };
        }),
    );
    const action: mountedMenu.MountedFileAction = {
      pluginId: "sshfs-lite",
      pluginName: "SSHFS Lite",
      fingerprint: "test",
      mount: { id: "m1", sessionId: "session-1", remotePath: "/srv", mountPoint: "Z:\\" },
    };
    render(<SftpPage sessionId="session-1" />);
    const remoteFile = await screen.findByText("readme.md");
    fireEvent.contextMenu(remoteFile);
    expect(discover).toHaveBeenCalledWith("session-1", "/srv/app/readme.md", expect.any(Function));
    fireEvent.contextMenu(screen.getByText("notes.txt"));
    await act(async () => finish());
    expect(
      useContextMenu.getState().menu?.items.some((item) => item.label.includes("SSHFS Lite")),
    ).toBe(false);
    discover.mockImplementationOnce(async (_session, _path, onAction) => {
      onAction?.(action);
      return [action];
    });
    const reveal = vi.spyOn(mountedMenu, "revealMountedFile").mockResolvedValueOnce();
    fireEvent.contextMenu(remoteFile);
    await waitFor(() =>
      expect(
        useContextMenu.getState().menu?.items.some((item) => item.label.includes("SSHFS Lite")),
      ).toBe(true),
    );
    useContextMenu
      .getState()
      .menu!.items.find((item) => item.label.includes("SSHFS Lite"))!
      .onSelect();
    expect(reveal).toHaveBeenCalledWith(action, "session-1", "/srv/app/readme.md");
    discover.mockRestore();
    reveal.mockRestore();
  });

  it("previews the selected local or remote file from the toolbar or Space, without editing it", async () => {
    useFilePreview.setState({ file: null });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const buttons = screen.getAllByRole("button", { name: "Preview file" });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("src"));
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("notes.txt"));
    fireEvent.click(buttons[0]!);
    expect(useFilePreview.getState().file).toMatchObject({
      path: "C:\\work\\notes.txt",
      source: { kind: "local" },
    });
    fireEvent.click(screen.getByText("readme.md"));
    const pane = document.querySelectorAll(".sftp-pane__body")[1]!;
    fireEvent.keyDown(pane, { key: " " });
    expect(useFilePreview.getState().file).toMatchObject({
      path: "/srv/app/readme.md",
      source: { kind: "remote", sessionId: "session-1" },
    });
    expect(useWorkspace.getState().openEditor).not.toHaveBeenCalled();
    expect(fsMock.openLocal).not.toHaveBeenCalled();
  });
  it("opens a folder in the next column and preserves the parent for changing branches", async () => {
    fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) => {
      if (source.kind === "local" && path === "C:\\work\\src")
        return {
          path,
          entries: [{ ...localListing.entries[0], name: "child.ts", path: `${path}\\child.ts` }],
        };
      return listingFor(source);
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0]!);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Column view" }));
    fireEvent.click(screen.getByText("src"));
    expect(await screen.findByText("child.ts")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    const columns = document.querySelectorAll('.sftp-miller__column [role="listbox"]');
    expect(columns.length).toBe(2);
    const proxy = within(columns[1]! as HTMLElement).getByRole("textbox", {
      name: "Type to select a file or folder",
    });
    expect(document.activeElement).toBe(proxy);
    fireEvent.keyDown(proxy, { key: "Home" });
    expect(
      within(columns[1]! as HTMLElement).getByRole("option", { selected: true }).textContent,
    ).toContain("child.ts");
    fireEvent.keyDown(proxy, { key: "ArrowLeft" });
    expect(screen.queryByText("child.ts")).toBeNull();
    expect(currentPath()).toBe("C:\\work");
  });

  it("commits Chinese IME input once and selects the matching file", async () => {
    fsMock.list.mockImplementation(async (source: FsSource) =>
      source.kind === "local"
        ? {
            ...localListing,
            entries: [
              ...localListing.entries,
              {
                ...localListing.entries[0],
                name: "微信-Installer.exe",
                path: "C:\\work\\微信-Installer.exe",
              },
            ],
          }
        : remoteListing,
    );
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    const proxy = within(local).getByRole("textbox", { name: "Type to select a file or folder" });
    fireEvent.compositionStart(proxy);
    fireEvent.compositionEnd(proxy, { data: "微信" });
    fireEvent.change(proxy, { target: { value: "微信" } });
    expect(within(local).getByRole("option", { selected: true }).textContent).toContain(
      "微信-Installer.exe",
    );
  });

  it("loads breadcrumb child folders only on expansion and navigates through the menu", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const before = fsMock.list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Subfolders of C:\\work" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "src" }));
    await waitFor(() =>
      expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\src"),
    );
    expect(fsMock.list.mock.calls.length).toBeGreaterThan(before);
  });

  it("uses customized file bindings and consumes them before global workbench commands", async () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        preloadDirs: false,
        keyboardShortcuts: { "files.newFile": ["Mod+Y"], "host.new": ["Mod+Y"] },
      },
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    const workbench = vi.fn();
    window.addEventListener("keydown", workbench);
    try {
      fireEvent.keyDown(local, { key: "y", ctrlKey: true });
      expect(screen.getByRole("textbox", { name: "File name" })).toBeTruthy();
      expect(workbench).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole("textbox", { name: "File name" }), { key: "Escape" });
      fireEvent.keyDown(local, { key: "n", ctrlKey: true });
      expect(screen.queryByRole("textbox", { name: "File name" })).toBeNull();
    } finally {
      window.removeEventListener("keydown", workbench);
    }
  });
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "focuses and selects the current panel path with Ctrl/Cmd+L (%j)",
    async (modifier) => {
      render(<SftpPage sessionId="session-1" />);
      await screen.findByText("notes.txt");
      await screen.findByText("readme.md");
      const local = screen.getAllByRole("listbox")[0]!;
      local.focus();
      expect(fireEvent.keyDown(local, { key: "l", ...modifier })).toBe(false);
      const localPath = screen.getByRole("textbox", { name: "Path" }) as HTMLInputElement;
      expect(document.activeElement).toBe(localPath);
      expect(localPath.selectionStart).toBe(0);
      expect(localPath.selectionEnd).toBe(localPath.value.length);
      fireEvent.keyDown(localPath, { key: "Escape" });

      const remotePane = document.querySelectorAll<HTMLElement>(".sftp-pane")[1]!;
      const refresh = within(remotePane).getByRole("button", { name: "Refresh" });
      refresh.focus();
      fireEvent.keyDown(refresh, { key: "l", ...modifier });
      const remotePath = within(remotePane).getByRole("textbox", {
        name: "Path",
      }) as HTMLInputElement;
      expect(document.activeElement).toBe(remotePath);
      expect(remotePath.selectionStart).toBe(0);
      expect(remotePath.selectionEnd).toBe(remotePath.value.length);

      fireEvent.change(remotePath, { target: { value: "/draft/path" } });
      remotePath.setSelectionRange(4, 4);
      fireEvent.keyDown(remotePath, { key: "l", ...modifier });
      expect(remotePath.value).toBe("/draft/path");
      expect(remotePath.selectionStart).toBe(0);
      expect(remotePath.selectionEnd).toBe("/draft/path".length);
    },
  );

  it("shows this computer next to the session panel", async () => {
    render(<SftpPage sessionId="session-1" />);

    expect(await screen.findByText("This computer")).toBeTruthy();
    expect(await screen.findByText("web-01")).toBeTruthy();
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(await screen.findByText("readme.md")).toBeTruthy();
  });

  it("reports a slow initial listing outside the file list and waits before showing an empty folder", async () => {
    let resolveListing!: (listing: typeof remoteListing) => void;
    fsMock.list.mockImplementation((source: FsSource) =>
      source.kind === "local"
        ? Promise.resolve(localListing)
        : new Promise((resolve) => {
            resolveListing = resolve;
          }),
    );
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const remote = screen.getAllByRole("listbox")[1]!;
    const pane = remote.closest(".sftp-pane") as HTMLElement;
    expect(remote.getAttribute("aria-busy")).toBe("true");
    expect(within(remote).queryByRole("status")).toBeNull();
    expect(within(pane).getByRole("status").textContent).toBe("Loading…");
    expect(within(remote).queryByText("Empty folder")).toBeNull();

    await act(async () => resolveListing({ ...remoteListing, entries: [] }));
    expect(remote.getAttribute("aria-busy")).toBe("false");
    expect(within(pane).getByRole("status").textContent).toBe("0 items");
    expect(within(remote).getByText("Empty folder")).toBeTruthy();
  });

  it.each(["refresh", "navigate"])(
    "keeps existing rows in place while a remote %s is pending",
    async (action) => {
      render(<SftpPage sessionId="session-1" />);
      const row = (await screen.findByText("readme.md")).closest(".sftp-row")!;
      const remote = screen.getAllByRole("listbox")[1]!;
      const pane = remote.closest(".sftp-pane") as HTMLElement;
      const contents = Array.from(remote.children);
      let resolveListing!: (listing: typeof remoteListing) => void;
      fsMock.list.mockImplementation((source: FsSource) =>
        source.kind === "local"
          ? Promise.resolve(localListing)
          : new Promise((resolve) => {
              resolveListing = resolve;
            }),
      );
      if (action === "refresh") {
        fireEvent.click(row);
        fireEvent.click(within(pane).getByRole("button", { name: "Refresh" }));
      } else {
        const path = openPath(1);
        fireEvent.change(path, { target: { value: "/srv/other" } });
        fireEvent.keyDown(path, { key: "Enter" });
      }
      expect(remote.getAttribute("aria-busy")).toBe("true");
      expect(within(pane).getByRole("status").textContent).toBe("Loading…");
      expect(within(remote).queryByRole("status")).toBeNull();
      expect(Array.from(remote.children)).toEqual(contents);
      expect(within(remote).getByText("readme.md").closest(".sftp-row")).toBe(row);

      await act(async () =>
        resolveListing({
          ...remoteListing,
          ...(action === "navigate" ? { path: "/srv/other", entries: [] } : {}),
        }),
      );
      expect(remote.getAttribute("aria-busy")).toBe("false");
      expect(within(pane).getByRole("status").textContent).toBe(
        action === "refresh" ? "1 items" : "0 items",
      );
      if (action === "refresh") {
        expect(within(remote).getByRole("option", { selected: true })).toBe(row);
        expect(Array.from(remote.children)).toEqual(contents);
      } else expect(within(remote).getByText("Empty folder")).toBeTruthy();
    },
  );

  it("renames in place from the keyboard", async () => {
    render(<SftpPage sessionId="session-1" />);
    const row = (await screen.findByText("notes.txt")).closest(".sftp-row") as HTMLElement;
    fireEvent.click(row);

    const local = screen.getAllByRole("listbox")[0] as HTMLElement;
    fireEvent.keyDown(local, { key: "F2" });

    const input = (await screen.findByDisplayValue("notes.txt")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "todo.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(fsMock.rename).toHaveBeenCalledWith(
        { kind: "local" },
        "C:\\work\\notes.txt",
        "C:\\work\\todo.txt",
      );
    });
  });

  it("creates an empty file from the header", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");

    fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
    const input = screen.getByPlaceholderText("File name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "draft.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(fsMock.createFile).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\draft.md");
    });
  });

  it("reveals the new inline row instead of scrolling to an old selection", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scroll,
    });
    try {
      render(<SftpPage sessionId="session-1" />);
      fireEvent.click((await screen.findByText("notes.txt")).closest(".sftp-row")!);
      fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
      await waitFor(() => {
        const latest = scroll.mock.contexts.at(-1) as HTMLElement | undefined;
        expect(latest?.classList.contains("is-creating")).toBe(true);
      });
      expect(document.activeElement?.closest(".sftp-row")?.classList.contains("is-creating")).toBe(
        true,
      );
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("copies the selected entry into the other panel", async () => {
    render(<SftpPage sessionId="session-1" />);
    const row = (await screen.findByText("notes.txt")).closest(".sftp-row") as HTMLElement;
    fireEvent.click(row);

    fireEvent.click(screen.getAllByRole("button", { name: "Upload" })[0]!);

    await waitFor(() => {
      expect(fsMock.transfer).toHaveBeenCalledWith(
        { kind: "local" },
        "C:\\work\\notes.txt",
        { kind: "remote", sessionId: "session-1" },
        "/srv/app/notes.txt",
        false,
        false,
      );
    });
  });

  it("transfers a whole selection", async () => {
    render(<SftpPage sessionId="session-1" />);
    const notes = (await screen.findByText("notes.txt")).closest(".sftp-row") as HTMLElement;
    const source = (await screen.findByText("src")).closest(".sftp-row") as HTMLElement;

    fireEvent.click(notes);
    fireEvent.click(source, { ctrlKey: true });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Upload" })[0]!);

    await waitFor(() => {
      expect(fsMock.transfer).toHaveBeenCalledTimes(2);
    });
    expect(fsMock.transfer).toHaveBeenCalledWith(
      { kind: "local" },
      "C:\\work\\src",
      { kind: "remote", sessionId: "session-1" },
      "/srv/app/src",
      false,
      false,
    );
  });

  it("selects everything with the keyboard", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0] as HTMLElement;
    fireEvent.keyDown(local, { key: "a", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());
  });

  it("opens local files in the editor", async () => {
    render(<SftpPage sessionId="session-1" />);
    const row = (await screen.findByText("notes.txt")).closest(".sftp-row") as HTMLElement;
    fireEvent.doubleClick(row);

    await waitFor(() => {
      expect(useWorkspace.getState().openLocalEditor).toHaveBeenCalledWith("C:\\work\\notes.txt");
    });
    expect(fsMock.openLocal).not.toHaveBeenCalled();
  });
});

describe("SftpPage asynchronous interactions", () => {
  it.each(["button", "keyboard", "external"] as const)(
    "preserves a multi-selection and range anchor across a %s refresh",
    async (trigger) => {
      render(<SftpPage sessionId="session-1" />);
      await screen.findByText("notes.txt");
      const local = screen.getAllByRole("listbox")[0]!;
      fireEvent.click(within(local).getByText("notes.txt"));
      fireEvent.click(within(local).getByText("src"), { ctrlKey: true });
      const before = fsMock.list.mock.calls.length;
      if (trigger === "external")
        act(() => domainEvents.filesChanged({ source: { kind: "local" }, origin: "another-pane" }));
      else if (trigger === "keyboard") fireEvent.keyDown(local, { key: "F5" });
      else fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]!);
      await waitFor(() => expect(fsMock.list.mock.calls.length).toBeGreaterThan(before));
      await waitFor(() => expect(local.getAttribute("aria-busy")).toBe("false"));
      expect(within(local).getAllByRole("option", { selected: true })).toHaveLength(2);
      fireEvent.keyDown(local, { key: "ArrowDown", shiftKey: true });
      expect(within(local).getAllByRole("option", { selected: true })).toHaveLength(2);
      fireEvent.keyDown(local, { key: "c", ctrlKey: true });
      expect(useFileClipboard.getState().clip?.items.map((entry) => entry.name)).toEqual([
        "src",
        "notes.txt",
      ]);
    },
  );

  it("prunes vanished selections and keeps keyboard actions on a surviving file", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.click(within(local).getByText("notes.txt"));
    fireEvent.click(within(local).getByText("src"), { ctrlKey: true });
    fsMock.list.mockImplementation(async (source: FsSource) =>
      source.kind === "local"
        ? { ...localListing, entries: [localListing.entries[0]!] }
        : remoteListing,
    );
    act(() => domainEvents.filesChanged({ source: { kind: "local" }, origin: "another-pane" }));
    await waitFor(() => expect(within(local).queryByText("src")).toBeNull());
    expect(within(local).getByRole("option", { selected: true }).textContent).toContain(
      "notes.txt",
    );
    fireEvent.keyDown(local, { key: "F2" });
    expect(await screen.findByDisplayValue("notes.txt")).toBeTruthy();
  });

  it("keeps a path draft and its focus when another pane changes files", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const input = openPath();
    fireEvent.change(input, { target: { value: "C:\\unfinished" } });
    const before = fsMock.list.mock.calls.length;
    act(() => domainEvents.filesChanged({ source: { kind: "local" }, origin: "another-pane" }));
    await waitFor(() => expect(fsMock.list.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getAllByRole("listbox")[0]!.getAttribute("aria-busy")).toBe("false"),
    );
    expect(input.value).toBe("C:\\unfinished");
    expect(document.activeElement).toBe(input);
  });

  it("starts a new selection on navigation even when the destination has matching entries", async () => {
    render(<SftpPage sessionId="session-1" />);
    fireEvent.click(await screen.findByText("notes.txt"));
    const input = openPath();
    fireEvent.change(input, { target: { value: "C:\\elsewhere" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(currentPath()).toBe("C:\\elsewhere"));
    expect(screen.getAllByRole("listbox")[0]!.querySelector('[aria-selected="true"]')).toBeNull();
  });

  it("refreshes an in-flight navigation destination and discards the superseded response", async () => {
    const pending: Array<(value: typeof localListing) => void> = [];
    fsMock.list.mockImplementation((source: FsSource, path?: string | null) => {
      if (source.kind === "local" && path === "C:\\next")
        return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve(listingFor(source));
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const path = openPath();
    fireEvent.change(path, { target: { value: "C:\\next" } });
    fireEvent.keyDown(path, { key: "Enter" });
    expect(pending).toHaveLength(1);
    act(() =>
      window.dispatchEvent(
        new CustomEvent("tunnelde:files-changed", {
          detail: { source: { kind: "local" }, origin: "other-tab" },
        }),
      ),
    );
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!({ ...localListing, path: "C:\\next", entries: [] }));
    await act(async () =>
      pending[0]!({ ...localListing, path: "C:\\obsolete", entries: localListing.entries }),
    );
    expect(currentPath()).toBe("C:\\next");
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\work");
  });

  it("does not clear a new directory's inline draft when an earlier create operation completes", async () => {
    let finish!: () => void;
    fsMock.createFile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
    const oldInput = document.querySelector(".sftp-row.is-creating input")!;
    fireEvent.change(oldInput, { target: { value: "first.txt" } });
    fireEvent.keyDown(oldInput, { key: "Enter" });
    const path = openPath();
    fireEvent.change(path, { target: { value: "C:\\elsewhere" } });
    fireEvent.keyDown(path, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "New file" })[0]!.hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
    const newInput = document.querySelector(".sftp-row.is-creating input")!;
    fireEvent.change(newInput, { target: { value: "second.txt" } });
    await act(async () => finish());
    await waitFor(() =>
      expect(
        (document.querySelector(".sftp-row.is-creating input") as HTMLInputElement)?.value,
      ).toBe("second.txt"),
    );
    expect(currentPath()).toBe("C:\\elsewhere");
  });

  it("refreshes the copied destination when completion arrives before the transfer id response", async () => {
    fsMock.transfer.mockImplementation(async () => {
      useTransfers.getState().apply({
        id: "already-done",
        direction: "transfer",
        name: "notes.txt",
        transferred: 12,
        total: 12,
        status: "done",
        error: null,
      });
      domainEvents.filesChanged({
        source: { kind: "remote", sessionId: "session-1" },
        origin: "native-transfer",
      });
      return "already-done";
    });
    render(<SftpPage sessionId="session-1" />);
    fireEvent.click((await screen.findByText("notes.txt")).closest(".sftp-row")!);
    fireEvent.click(screen.getAllByRole("button", { name: "Upload" })[0]!);
    await waitFor(() =>
      expect(fsMock.list).toHaveBeenCalledWith(
        { kind: "remote", sessionId: "session-1" },
        "/srv/app",
      ),
    );
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\work");
  });

  it("coalesces background file changes without rereading unrelated sources", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    await screen.findByText("readme.md");
    fsMock.list.mockClear();
    act(() => {
      for (let index = 0; index < 100; index++) {
        domainEvents.filesChanged({ source: { kind: "local" }, origin: "background-task" });
        domainEvents.filesChanged({
          source: { kind: "remote", sessionId: "unrelated-session" },
          origin: "background-task",
        });
      }
    });
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledTimes(1));
    expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work");
  });

  it("refreshes both endpoints of a background move and cancels queued reads on unmount", async () => {
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    await screen.findByText("readme.md");
    fsMock.list.mockClear();
    act(() => {
      domainEvents.filesChanged({ source: { kind: "local" }, origin: "background-task" });
      domainEvents.filesChanged({
        source: { kind: "remote", sessionId: session.id },
        origin: "background-task",
      });
    });
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledTimes(2));
    expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work");
    expect(fsMock.list).toHaveBeenCalledWith({ kind: "remote", sessionId: session.id }, "/srv/app");
    fsMock.list.mockClear();
    act(() => domainEvents.filesChanged({ source: { kind: "local" }, origin: "background-task" }));
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fsMock.list).not.toHaveBeenCalled();
  });

  it("removes only successfully moved items from a cut batch and refreshes after partial failure", async () => {
    useFileClipboard.setState({
      clip: {
        source: { kind: "local" },
        action: "cut",
        items: [
          { path: "C:\\elsewhere\\one.txt", name: "one.txt", isDir: false },
          { path: "C:\\elsewhere\\two.txt", name: "two.txt", isDir: false },
        ],
      },
    });
    fsMock.rename
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Permission denied"));
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.rename).toHaveBeenCalledTimes(2));
    expect(useFileClipboard.getState().clip?.items.map((entry) => entry.name)).toEqual(["two.txt"]);
    await waitFor(() =>
      expect(fsMock.list.mock.calls.filter(([, path]) => path === "C:\\work")).toHaveLength(2),
    );
  });

  it("does not let a slower previous directory replace the current directory", async () => {
    let resolveSlow!: (value: typeof localListing) => void;
    fsMock.list.mockImplementation((source: FsSource, path?: string | null) => {
      if (path === "C:\\slow")
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      return Promise.resolve({ ...listingFor(source), path: path ?? listingFor(source).path });
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const path = openPath();
    fireEvent.change(path, { target: { value: "C:\\slow" } });
    fireEvent.keyDown(path, { key: "Enter" });
    const nextPath = openPath();
    fireEvent.change(nextPath, { target: { value: "C:\\fast" } });
    fireEvent.keyDown(nextPath, { key: "Enter" });
    await waitFor(() => expect(currentPath()).toBe("C:\\fast"));
    await act(async () => resolveSlow({ ...localListing, path: "C:\\slow" }));
    expect(currentPath()).toBe("C:\\fast");
  });

  it("returns to navigation history rather than assuming the parent folder", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const path = openPath();
    fireEvent.change(path, { target: { value: "D:\\other" } });
    fireEvent.keyDown(path, { key: "Enter" });
    await waitFor(() => expect(currentPath()).toBe("D:\\other"));
    const body = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(body, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(currentPath()).toBe("C:\\work"));
    fireEvent.keyDown(body, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(currentPath()).toBe("D:\\other"));
  });

  it("contracts an extended keyboard selection using its cursor", async () => {
    render(<SftpPage sessionId="session-1" />);
    fireEvent.click((await screen.findByText("notes.txt")).closest(".sftp-row")!);
    const body = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(body, { key: "ArrowUp", shiftKey: true });
    expect(within(body).getAllByRole("option", { selected: true })).toHaveLength(2);
    fireEvent.keyDown(body, { key: "ArrowDown", shiftKey: true });
    expect(within(body).getAllByRole("option", { selected: true })).toHaveLength(1);
  });

  it("keeps an inline rename focused when its input is clicked", async () => {
    render(<SftpPage sessionId="session-1" />);
    fireEvent.click((await screen.findByText("notes.txt")).closest(".sftp-row")!);
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "F2" });
    const input = screen.getByDisplayValue("notes.txt");
    fireEvent.click(input);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "bad/name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fsMock.rename).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("bad/name")).toBeTruthy();
  });

  it("accepts the same MIME type written by a file drag", async () => {
    render(<SftpPage sessionId="session-1" />);
    const row = (await screen.findByText("notes.txt")).closest(".sftp-row")!;
    const store: Record<string, string> = {};
    const dataTransfer = {
      types: [DRAG_MIME],
      setData: (key: string, value: string) => {
        store[key] = value;
      },
      getData: (key: string) => store[key] ?? "",
    };
    fireEvent.dragStart(row, { dataTransfer });
    const remote = screen.getAllByRole("listbox")[1]!;
    fireEvent.dragOver(remote, { dataTransfer });
    expect(remote.classList.contains("is-drop")).toBe(true);
    fireEvent.drop(remote, { dataTransfer });
    await waitFor(() =>
      expect(fsMock.transfer).toHaveBeenCalledWith(
        { kind: "local" },
        "C:\\work\\notes.txt",
        { kind: "remote", sessionId: "session-1" },
        "/srv/app/notes.txt",
        false,
        false,
      ),
    );
  });

  it("retains a cut selection when its move fails", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "C:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    fsMock.rename.mockRejectedValue(new Error("Permission denied"));
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.rename).toHaveBeenCalled());
    expect(useFileClipboard.getState().clip).toBe(clip);
  });

  it("keeps a cross-drive cut until the background move completes", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(fsMock.transfer).toHaveBeenCalledWith(
        { kind: "local" },
        "D:\\elsewhere\\move.txt",
        { kind: "local" },
        "C:\\work\\move.txt",
        true,
        false,
      ),
    );
    expect(useFileClipboard.getState().clip).toBe(clip);
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 12,
        total: 12,
        status: "done",
        error: null,
      }),
    );
    await waitFor(() => expect(useFileClipboard.getState().clip).toBeNull());
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it("keeps the cut completion callback when a transfer is paused and resumed", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalled());
    act(() =>
      useTransfers.setState({
        items: [
          {
            id: "transfer-1",
            direction: "transfer",
            name: "move.txt",
            transferred: 4,
            total: 12,
            status: "paused",
            error: null,
            updatedAt: Date.now(),
          },
        ],
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(useFileClipboard.getState().clip).toBe(clip);
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 12,
        total: 12,
        status: "done",
        error: null,
      }),
    );
    await waitFor(() => expect(useFileClipboard.getState().clip).toBeNull());
  });

  it("keeps the cut completion callback when a failed transfer is retried", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalled());
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 4,
        total: 12,
        status: "failed",
        error: "network error",
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(useFileClipboard.getState().clip).toBe(clip);
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 12,
        total: 12,
        status: "done",
        error: null,
      }),
    );
    await waitFor(() => expect(useFileClipboard.getState().clip).toBeNull());
  });

  it("clears the original cut after the file page closes and the move completes", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalled());
    view.unmount();
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 12,
        total: 12,
        status: "done",
        error: null,
      }),
    );
    expect(useFileClipboard.getState().clip).toBeNull();
  });

  it("does not clear a newer clipboard selection when a previous move completes", async () => {
    const oldClip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    const newClip = {
      source: { kind: "local" } as FsSource,
      action: "copy" as const,
      items: [{ path: "C:\\work\\notes.txt", name: "notes.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip: oldClip });
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalled());
    view.unmount();
    useFileClipboard.setState({ clip: newClip });
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 12,
        total: 12,
        status: "done",
        error: null,
      }),
    );
    expect(useFileClipboard.getState().clip).toBe(newClip);
  });

  it("releases a move watcher when the original clipboard is replaced before any event", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const subscribe = useTransfers.subscribe;
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const spy = vi.spyOn(useTransfers, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      const dispose = vi.fn(unsubscribe);
      disposals.push(dispose);
      return dispose;
    });
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(disposals).toHaveLength(1));
    view.unmount();
    act(() => useFileClipboard.getState().set(null));
    expect(disposals[0]).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("does not watch clipboard completion for a cross-drive copy", async () => {
    useFileClipboard.setState({
      clip: {
        source: { kind: "local" },
        action: "copy",
        items: [{ path: "D:\\elsewhere\\copy.txt", name: "copy.txt", isDir: false }],
      },
    });
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const spy = vi.spyOn(useTransfers, "subscribe");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    view.unmount();
  });

  it("removes only completed items from a multi-file cut in completion order", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [
        { path: "D:\\elsewhere\\one.txt", name: "one.txt", isDir: false },
        { path: "D:\\elsewhere\\two.txt", name: "two.txt", isDir: false },
      ],
    };
    fsMock.transfer.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    useFileClipboard.setState({ clip });
    const view = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalledTimes(2));
    view.unmount();
    act(() =>
      useTransfers.getState().apply({
        id: "second",
        direction: "transfer",
        name: "two.txt",
        transferred: 1,
        total: 1,
        status: "done",
        error: null,
      }),
    );
    expect(useFileClipboard.getState().clip?.items.map((item) => item.name)).toEqual(["one.txt"]);
    act(() =>
      useTransfers.getState().apply({
        id: "first",
        direction: "transfer",
        name: "one.txt",
        transferred: 1,
        total: 1,
        status: "done",
        error: null,
      }),
    );
    expect(useFileClipboard.getState().clip).toBeNull();
  });

  it("retains a cross-drive cut when the background move is cancelled", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "D:\\elsewhere\\move.txt", name: "move.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalled());
    act(() =>
      useTransfers.getState().apply({
        id: "transfer-1",
        direction: "transfer",
        name: "move.txt",
        transferred: 0,
        total: 12,
        status: "cancelled",
        error: null,
      }),
    );
    act(() => domainEvents.filesChanged({ source: { kind: "local" }, origin: "native-transfer" }));
    await waitFor(() =>
      expect(
        fsMock.list.mock.calls.filter(([, path]) => path === "C:\\work").length,
      ).toBeGreaterThan(1),
    );
    expect(useFileClipboard.getState().clip).toBe(clip);
  });

  it("asks before replacing a target and preserves the cut source while awaiting confirmation", async () => {
    const clip = {
      source: { kind: "local" } as FsSource,
      action: "cut" as const,
      items: [{ path: "C:\\elsewhere\\notes.txt", name: "notes.txt", isDir: false }],
    };
    useFileClipboard.setState({ clip });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(useDialogs.getState().confirm).toHaveBeenCalled());
    expect(fsMock.rename).not.toHaveBeenCalled();
    expect(useFileClipboard.getState().clip).toBe(clip);
  });
});

describe("SftpPage source picker", () => {
  it("renames the file tab when the selected host changes", async () => {
    useSsh.setState({
      sessions: [session, { ...session, id: "session-2", hostId: "host-2", title: "other server" }],
    });
    useWorkspace.setState({
      tabs: [
        { id: "sftp:session-1", kind: "sftp", title: "web-01", hostId: "host-1", pinned: false },
      ],
    });
    render(<SftpPage sessionId="session-1" tabId="sftp:session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getAllByRole("button", { name: "Source" })[1]!);
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Source" })).getByRole("option", {
        name: "other server",
      }),
    );
    expect(useWorkspace.getState().tabs[0]?.title).toBe("other server");
    await waitFor(() => expect(useWorkspace.getState().tabs[0]?.fileSessionId).toBe("session-2"));
    await waitFor(() =>
      expect(fsMock.list).toHaveBeenCalledWith({ kind: "remote", sessionId: "session-2" }, null),
    );
  });
  it("moves a cut file between sessions of the same host with a remote rename", async () => {
    useSsh.setState({ sessions: [session, { ...session, id: "session-2" }] });
    useFileClipboard.setState({
      clip: {
        source: { kind: "remote", sessionId: "session-2" },
        action: "cut",
        items: [{ path: "/tmp/source.txt", name: "source.txt", isDir: false }],
      },
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("readme.md");
    fireEvent.keyDown(screen.getAllByRole("listbox")[1]!, { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(fsMock.rename).toHaveBeenCalledWith(
        { kind: "remote", sessionId: "session-1" },
        "/tmp/source.txt",
        "/srv/app/source.txt",
        false,
      ),
    );
    expect(fsMock.transfer).not.toHaveBeenCalled();
  });

  it("lists one row per host even when the host has several sessions", () => {
    useSsh.setState({ sessions: [session, { ...session, id: "session-2" }] });
    render(<SftpPage sessionId="session-1" />);

    const picker = screen.getAllByRole("button", { name: "Source" })[0]!;
    fireEvent.click(picker);

    const popup = screen.getByRole("listbox", { name: "Source" });
    const labels = within(popup)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["This computer", "web-01"]);
  });

  it("keeps old and new addresses separate when a saved host is edited", async () => {
    useSsh.setState({
      sessions: [session, { ...session, id: "session-2", address: "root@10.0.0.6:22" }],
    });
    useFileClipboard.setState({
      clip: {
        source: { kind: "remote", sessionId: "session-2" },
        action: "cut",
        items: [{ path: "/tmp/source.txt", name: "source.txt", isDir: false }],
      },
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("readme.md");
    fireEvent.click(screen.getAllByRole("button", { name: "Source" })[0]!);
    const popup = screen.getByRole("listbox", { name: "Source" });
    expect(within(popup).getByRole("option", { name: "web-01 (root@10.0.0.5:22)" })).toBeTruthy();
    expect(within(popup).getByRole("option", { name: "web-01 (root@10.0.0.6:22)" })).toBeTruthy();
    fireEvent.keyDown(screen.getAllByRole("listbox", { name: "Files" })[1]!, {
      key: "v",
      ctrlKey: true,
    });
    await waitFor(() => expect(fsMock.transfer).toHaveBeenCalled());
    expect(fsMock.rename).not.toHaveBeenCalled();
  });
});

describe("SftpPage preloading", () => {
  const viewFolders = [
    { name: ".secret", isHidden: true, size: 0, modified: 0 },
    { name: "folder10", isHidden: false, size: 10, modified: 10 },
    { name: "folder2", isHidden: false, size: 2, modified: 2 },
  ].map((entry): FileEntry => ({
    ...entry,
    path: `C:\\work\\${entry.name}`,
    isDir: true,
    permissions: null,
  }));
  const mockViewFolders = () =>
    fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) =>
      source.kind === "local"
        ? { path: path ?? localListing.path, entries: path ? [] : viewFolders }
        : { path: path ?? remoteListing.path, entries: [] },
    );

  it("warms the parent and child folders when the setting is on", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, preloadDirs: true } });
    render(<SftpPage sessionId="session-1" />);

    await screen.findByText("notes.txt");
    await waitFor(() => {
      expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\");
      expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\src");
    });
  });

  it("stays lazy when the setting is off", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, preloadDirs: false } });
    render(<SftpPage sessionId="session-1" />);

    await screen.findByText("notes.txt");
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\");
  });

  it("suppresses speculative directory requests in lightweight mode and resumes them live", async () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, preloadDirs: true, lightweightMode: true },
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\");
    act(() =>
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, preloadDirs: true, lightweightMode: false },
      }),
    );
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\"));
  });

  it.each(["name", "size", "modified"] as const)(
    "prioritizes visible %s order and changes targets without reloading the open directory",
    async (sortBy) => {
      mockViewFolders();
      useSettings.setState({
        settings: { ...DEFAULT_SETTINGS, preloadDirs: true, preloadCount: 1, filesSortBy: sortBy },
      });
      render(<SftpPage sessionId="session-1" />);
      await waitFor(() =>
        expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\folder2"),
      );
      expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\.secret");
      expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\folder10");
      fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0]!);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Descending" }));
      await waitFor(() =>
        expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\folder10"),
      );
      expect(fsMock.list.mock.calls.filter(([, path]) => path === null)).toHaveLength(2);
      expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, localListing.path);
    },
  );

  it("updates preload targets when hidden directories become visible without reloading the current directory", async () => {
    mockViewFolders();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, preloadDirs: true, preloadCount: 1 } });
    render(<SftpPage sessionId="session-1" />);
    await waitFor(() =>
      expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\folder2"),
    );
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\.secret");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "h", ctrlKey: true });
    await waitFor(() =>
      expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work\\.secret"),
    );
    expect(fsMock.list.mock.calls.filter(([, path]) => path === null)).toHaveLength(2);
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, localListing.path);
  });

  it.each([0, 5])("preloads exactly the parent plus %i children", async (count) => {
    const entries = Array.from({ length: 7 }, (_, index): FileEntry => ({
      name: `folder${index}`,
      path: `C:\\work\\folder${index}`,
      isDir: true,
      isHidden: false,
      size: 0,
      modified: null,
      permissions: null,
    }));
    fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) =>
      source.kind === "local"
        ? { path: path ?? localListing.path, entries: path ? [] : entries }
        : { path: path ?? remoteListing.path, entries: [] },
    );
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, preloadDirs: true, preloadCount: count },
    });
    render(<SftpPage sessionId="session-1" />);
    await waitFor(() =>
      expect(
        fsMock.list.mock.calls.filter(([source, path]) => source.kind === "local" && path),
      ).toHaveLength(count + 1),
    );
    const paths = fsMock.list.mock.calls
      .filter(([source, path]) => source.kind === "local" && path)
      .map(([, path]) => path);
    expect(paths).toEqual(["C:\\", ...entries.slice(0, count).map((entry) => entry.path)]);
  });
});

describe("SftpPage visible file interactions", () => {
  const hidden: FileEntry = {
    name: ".env",
    path: "C:\\work\\.env",
    isDir: false,
    isHidden: true,
    size: 5,
    modified: null,
    permissions: null,
  };
  const withHidden = () => {
    fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) => {
      const listing =
        source.kind === "local"
          ? { ...localListing, entries: [...localListing.entries, hidden] }
          : remoteListing;
      return { ...listing, path: path ?? listing.path };
    });
  };

  it("selects, ranges, and batches only visible rows in their displayed order", async () => {
    withHidden();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    expect(screen.queryByText(".env")).toBeNull();
    const body = screen.getAllByRole("listbox")[0]!;
    expect(
      within(body)
        .getAllByRole("option")
        .map((row) => row.dataset.path),
    ).toEqual(["C:\\work\\src", "C:\\work\\notes.txt"]);
    fireEvent.keyDown(body, { key: "Home" });
    fireEvent.keyDown(body, { key: "ArrowDown", shiftKey: true });
    expect(within(body).getAllByRole("option", { selected: true })).toHaveLength(2);
    fireEvent.keyDown(body, { key: "a", ctrlKey: true });
    fireEvent.keyDown(body, { key: "c", ctrlKey: true });
    expect(useFileClipboard.getState().clip?.items.map((entry) => entry.name)).toEqual([
      "src",
      "notes.txt",
    ]);
  });

  it("scopes the hidden shortcut to the file list and ignores invisible old selections", async () => {
    withHidden();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const path = openPath();
    fireEvent.keyDown(path, { key: "h", ctrlKey: true });
    expect(useSettings.getState().settings.filesShowHidden).toBe(false);
    const body = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(body, { key: "h", ctrlKey: true });
    fireEvent.click((await within(body).findByText(".env")).closest(".sftp-row")!);
    fireEvent.keyDown(body, { key: "h", ctrlKey: true });
    expect(within(body).queryByText(".env")).toBeNull();
    fireEvent.keyDown(body, { key: "Delete" });
    expect(useDialogs.getState().confirm).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Upload" })[0]!.hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("checks hidden raw entries when creating a file with an existing name", async () => {
    withHidden();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
    const input = document.querySelector(".sftp-row.is-creating input")!;
    fireEvent.change(input, { target: { value: ".env" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fsMock.createFile).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe(".env");
  });

  it("requires overwrite confirmation for an invisible paste destination", async () => {
    withHidden();
    useFileClipboard.setState({
      clip: {
        source: { kind: "local" },
        action: "copy",
        items: [{ path: "C:\\elsewhere\\.env", name: ".env", isDir: false }],
      },
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    fireEvent.keyDown(screen.getAllByRole("listbox")[0]!, { key: "v", ctrlKey: true });
    await waitFor(() => expect(useDialogs.getState().confirm).toHaveBeenCalled());
    expect(fsMock.copy).not.toHaveBeenCalled();
    const dialog = vi.mocked(useDialogs.getState().confirm).mock.calls[0]![0];
    expect(dialog.body).toContain(".env");
  });

  it("applies view menu preferences immediately without reading the filesystem again", async () => {
    withHidden();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const reads = fsMock.list.mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show hidden files" }));
    const body = screen.getAllByRole("listbox")[0]!;
    expect(await within(body).findByText(".env")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Folders first" }));
    await waitFor(() =>
      expect(within(body).getAllByRole("option")[0]!.dataset.path).toBe(hidden.path),
    );
    expect(fsMock.list).toHaveBeenCalledTimes(reads);
  });

  it.each(["create", "rename"] as const)(
    "temporarily reveals a hidden file after %s and clears it on navigation",
    async (operation) => {
      let entries: FileEntry[] = [...localListing.entries];
      fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) =>
        source.kind === "local" ? { path: path ?? localListing.path, entries } : remoteListing,
      );
      fsMock.createFile.mockImplementation(async () => {
        entries = [...entries, hidden];
      });
      fsMock.rename.mockImplementation(async () => {
        entries = [...entries.filter((entry) => entry.name !== "notes.txt"), hidden];
      });
      render(<SftpPage sessionId="session-1" />);
      const notes = await screen.findByText("notes.txt");
      const body = screen.getAllByRole("listbox")[0]!;
      if (operation === "create")
        fireEvent.click(screen.getAllByRole("button", { name: "New file" })[0]!);
      else {
        fireEvent.click(notes.closest(".sftp-row")!);
        fireEvent.keyDown(body, { key: "F2" });
      }
      const input = document.querySelector(".sftp-row input")!;
      fireEvent.change(input, { target: { value: ".env" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(
          within(body).getByText(".env").closest(".sftp-row")?.getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(useSettings.getState().settings.filesShowHidden).toBe(false);
      fireEvent.keyDown(body, { key: "Backspace" });
      await waitFor(() => expect(currentPath()).toBe("C:\\"));
      expect(within(body).queryByText(".env")).toBeNull();
    },
  );

  it("copies paths through the native-aware clipboard helper", async () => {
    const copy = vi.spyOn(clipboard, "copyText").mockImplementation(() => undefined);
    render(<SftpPage sessionId="session-1" />);
    fireEvent.contextMenu((await screen.findByText("notes.txt")).closest(".sftp-row")!);
    useContextMenu
      .getState()
      .menu!.items.find((item) => item.label === "Copy path")!
      .onSelect();
    expect(copy).toHaveBeenCalledExactlyOnceWith("C:\\work\\notes.txt");
  });

  it("keeps two panels and simultaneous tabs independent and restores a saved host after reconnect", async () => {
    withHidden();
    const rendered = render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(local, { key: "h", ctrlKey: true });
    expect(within(local).getByText(".env")).toBeTruthy();
    expect(useSettings.getState().settings.filesShowHidden).toBe(DEFAULT_SETTINGS.filesShowHidden);
    const localPane = local.closest(".sftp-pane")!;
    const remotePane = screen.getAllByRole("listbox")[1]!.closest(".sftp-pane")!;
    fireEvent.click(within(localPane as HTMLElement).getByRole("button", { name: "Size" }));
    expect(
      within(localPane as HTMLElement)
        .getByRole("columnheader", { name: "Size" })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(
      within(remotePane as HTMLElement)
        .getByRole("columnheader", { name: "Name" })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    const second = render(<SftpPage sessionId="session-1" />);
    await waitFor(() => expect(screen.getAllByRole("listbox")).toHaveLength(4));
    await waitFor(() =>
      expect(within(screen.getAllByRole("listbox")[2]!).getByText(".env")).toBeTruthy(),
    );
    fireEvent.keyDown(local, { key: "h", ctrlKey: true });
    expect(within(local).queryByText(".env")).toBeNull();
    expect(within(screen.getAllByRole("listbox")[2]!).getByText(".env")).toBeTruthy();
    fireEvent.keyDown(local, { key: "h", ctrlKey: true });
    second.unmount();
    rendered.unmount();
    useSsh.setState({ sessions: [{ ...session, id: "session-reconnected" }] });
    render(<SftpPage sessionId="session-reconnected" />);
    expect(await screen.findByText(".env")).toBeTruthy();
    expect(
      screen.getAllByRole("columnheader", { name: "Size" })[0]!.getAttribute("aria-sort"),
    ).toBe("ascending");
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "filters only the current panel with Ctrl/Cmd+F and clears on Escape (%j)",
    async (modifier) => {
      render(<SftpPage sessionId="session-1" />);
      await screen.findByText("notes.txt");
      await screen.findByText("readme.md");
      const local = screen.getAllByRole("listbox")[0]!;
      fireEvent.click(within(local).getByText("src"));
      fireEvent.keyDown(local, { key: "f", ...modifier });
      const filter = screen.getByRole("textbox", { name: "Filter files" });
      await waitFor(() => expect(document.activeElement).toBe(filter));
      fireEvent.change(filter, { target: { value: "NOTES" } });
      expect(within(local).queryByText("src")).toBeNull();
      expect(within(local).getByText("notes.txt")).toBeTruthy();
      expect(screen.getByText("readme.md")).toBeTruthy();
      fireEvent.keyDown(local, { key: "Delete" });
      expect(useDialogs.getState().confirm).not.toHaveBeenCalled();
      fireEvent.keyDown(local, { key: "a", ctrlKey: true });
      fireEvent.keyDown(local, { key: "c", ctrlKey: true });
      expect(useFileClipboard.getState().clip?.items.map((item) => item.name)).toEqual([
        "notes.txt",
      ]);
      fireEvent.keyDown(filter, { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "Filter files" })).toBeNull();
      expect(local.contains(document.activeElement)).toBe(true);
      expect(within(local).getByText("src")).toBeTruthy();
    },
  );

  it("folds groups without retaining invisible selections or forwarding group keyboard events", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.click(screen.getAllByRole("button", { name: "View options" })[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Group by type" }));
    fireEvent.click(within(local).getByText("src"));
    const group = within(local).getByRole("button", { name: /Folders 1/ });
    const before = fsMock.list.mock.calls.length;
    fireEvent.keyDown(group, { key: "Enter" });
    expect(fsMock.list).toHaveBeenCalledTimes(before);
    fireEvent.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(within(local).queryByText("src")).toBeNull();
    fireEvent.keyDown(local, { key: "Delete" });
    expect(useDialogs.getState().confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(local, { key: "a", ctrlKey: true });
    expect(
      within(local)
        .getAllByRole("option", { selected: true })
        .map((row) => row.dataset.path),
    ).toEqual(["C:\\work\\notes.txt"]);
    fireEvent.click(group);
    expect(within(local).getByText("src")).toBeTruthy();
  });

  it("offers native file manager actions only for local entries", async () => {
    const reveal = vi.spyOn(api, "revealLocalPath").mockResolvedValue();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const [local, remote] = screen.getAllByRole("listbox");
    fireEvent.contextMenu(within(local!).getByText("notes.txt").closest(".sftp-row")!);
    const action = useContextMenu
      .getState()
      .menu?.items.find((item) => item.label === "Reveal in file manager");
    expect(action).toBeTruthy();
    action?.onSelect();
    expect(reveal).toHaveBeenCalledWith("C:\\work\\notes.txt");
    fireEvent.contextMenu(within(remote!).getByText("readme.md").closest(".sftp-row")!);
    expect(
      useContextMenu.getState().menu?.items.some((item) => item.label === "Reveal in file manager"),
    ).toBe(false);
    fireEvent.contextMenu(within(local!).getByText("src").closest(".sftp-row")!);
    useContextMenu
      .getState()
      .menu?.items.find((item) => item.label === "Open folder in file manager")
      ?.onSelect();
    expect(fsMock.openLocal).toHaveBeenCalledWith("C:\\work\\src");
    reveal.mockRestore();
  });

  it("updates the keyboard cursor when a different entry is selected by its context menu", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.click(within(local).getByText("src"));
    fireEvent.contextMenu(within(local).getByText("notes.txt").closest(".sftp-row")!);
    fireEvent.keyDown(local, { key: "F2" });
    expect((local.querySelector(".sftp-row input") as HTMLInputElement).value).toBe("notes.txt");
  });

  it("renames the sole selected item after Ctrl-click deselects the keyboard cursor item", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.click(within(local).getByText("notes.txt"));
    fireEvent.click(within(local).getByText("src"), { ctrlKey: true });
    fireEvent.click(within(local).getByText("src"), { ctrlKey: true });
    expect(within(local).getAllByRole("option", { selected: true })[0]!.dataset.path).toBe(
      "C:\\work\\notes.txt",
    );
    fireEvent.keyDown(local, { key: "F2" });
    expect((local.querySelector(".sftp-row input") as HTMLInputElement).value).toBe("notes.txt");
  });

  it("navigates to the parent directory with Alt+Up instead of moving the selection", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(local, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\"));
  });

  it("supports Finder command navigation and hidden file shortcuts without changing Ctrl+Up", async () => {
    withHidden();
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(local, { key: "ArrowUp", ctrlKey: true });
    expect(fsMock.list).not.toHaveBeenCalledWith({ kind: "local" }, "C:\\");
    fireEvent.keyDown(local, { key: ".", code: "Period", metaKey: true, shiftKey: true });
    expect(within(local).getByText(".env")).toBeTruthy();
    fireEvent.click(within(local).getByText("notes.txt"));
    fireEvent.keyDown(local, { key: "ArrowDown", metaKey: true });
    expect(useWorkspace.getState().openLocalEditor).toHaveBeenCalledWith("C:\\work\\notes.txt");
    fireEvent.keyDown(local, { key: "ArrowUp", metaKey: true });
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\"));
  });
});
