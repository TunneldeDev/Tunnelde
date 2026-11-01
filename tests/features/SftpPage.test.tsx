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
import { DRAG_MIME } from "@/lib/files/dnd";
import { useContextMenu } from "@/store/contextMenu";
import * as clipboard from "@/lib/session/clipboard";

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

  useSsh.setState({ sessions: [session] });
  useHosts.setState({ hosts: [] });
  useDialogs.setState({ confirm: vi.fn(), openConnect: vi.fn() });
  useWorkspace.setState({ openEditor: vi.fn() });
  useTransfers.setState({ items: [] });
  useFileClipboard.setState({ clip: null });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, preloadDirs: false } });
});

describe("SftpPage", () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "focuses and selects the current panel path with Ctrl/Cmd+L (%j)",
    async (modifier) => {
      render(<SftpPage sessionId="session-1" />);
      await screen.findByText("notes.txt");
      await screen.findByText("readme.md");
      const paths = screen.getAllByRole("textbox", { name: "Path" }) as HTMLInputElement[];
      const local = screen.getAllByRole("listbox")[0]!;
      local.focus();
      expect(fireEvent.keyDown(local, { key: "l", ...modifier })).toBe(false);
      expect(document.activeElement).toBe(paths[0]);
      expect(paths[0]!.selectionStart).toBe(0);
      expect(paths[0]!.selectionEnd).toBe(paths[0]!.value.length);

      const remotePane = paths[1]!.closest(".sftp-pane") as HTMLElement;
      const refresh = within(remotePane).getByRole("button", { name: "Refresh" });
      refresh.focus();
      fireEvent.keyDown(refresh, { key: "l", ...modifier });
      expect(document.activeElement).toBe(paths[1]);
      expect(paths[1]!.selectionStart).toBe(0);
      expect(paths[1]!.selectionEnd).toBe(paths[1]!.value.length);

      fireEvent.change(paths[1]!, { target: { value: "/draft/path" } });
      paths[1]!.setSelectionRange(4, 4);
      fireEvent.keyDown(paths[1]!, { key: "l", ...modifier });
      expect(paths[1]!.value).toBe("/draft/path");
      expect(paths[1]!.selectionStart).toBe(0);
      expect(paths[1]!.selectionEnd).toBe("/draft/path".length);
    },
  );

  it("shows this computer next to the session panel", async () => {
    render(<SftpPage sessionId="session-1" />);

    expect(await screen.findByText("This computer")).toBeTruthy();
    expect(await screen.findByText("web-01")).toBeTruthy();
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    expect(await screen.findByText("readme.md")).toBeTruthy();
  });

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

  it("opens local files with the system handler", async () => {
    render(<SftpPage sessionId="session-1" />);
    const row = (await screen.findByText("notes.txt")).closest(".sftp-row") as HTMLElement;
    fireEvent.doubleClick(row);

    await waitFor(() => {
      expect(fsMock.openLocal).toHaveBeenCalledWith("C:\\work\\notes.txt");
    });
    expect(useWorkspace.getState().openEditor).not.toHaveBeenCalled();
  });
});

describe("SftpPage asynchronous interactions", () => {
  it("refreshes an in-flight navigation destination and discards the superseded response", async () => {
    const pending: Array<(value: typeof localListing) => void> = [];
    fsMock.list.mockImplementation((source: FsSource, path?: string | null) => {
      if (source.kind === "local" && path === "C:\\next")
        return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve(listingFor(source));
    });
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const path = screen.getAllByRole("textbox", { name: "Path" })[0]!;
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
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!({ ...localListing, path: "C:\\next", entries: [] }));
    await act(async () =>
      pending[0]!({ ...localListing, path: "C:\\obsolete", entries: localListing.entries }),
    );
    expect((path as HTMLInputElement).value).toBe("C:\\next");
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
    const path = screen.getAllByRole("textbox", { name: "Path" })[0]!;
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
    expect((path as HTMLInputElement).value).toBe("C:\\elsewhere");
  });

  it("refreshes both panels when completion arrives before the transfer id response", async () => {
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
      return "already-done";
    });
    render(<SftpPage sessionId="session-1" />);
    fireEvent.click((await screen.findByText("notes.txt")).closest(".sftp-row")!);
    fireEvent.click(screen.getAllByRole("button", { name: "Upload" })[0]!);
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\work"));
    await waitFor(() =>
      expect(fsMock.list).toHaveBeenCalledWith(
        { kind: "remote", sessionId: "session-1" },
        "/srv/app",
      ),
    );
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
    const path = screen.getAllByRole("textbox", { name: "Path" })[0]!;
    fireEvent.change(path, { target: { value: "C:\\slow" } });
    fireEvent.keyDown(path, { key: "Enter" });
    fireEvent.change(path, { target: { value: "C:\\fast" } });
    fireEvent.keyDown(path, { key: "Enter" });
    await waitFor(() => expect((path as HTMLInputElement).value).toBe("C:\\fast"));
    await act(async () => resolveSlow({ ...localListing, path: "C:\\slow" }));
    expect((path as HTMLInputElement).value).toBe("C:\\fast");
  });

  it("returns to navigation history rather than assuming the parent folder", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const path = screen.getAllByRole("textbox", { name: "Path" })[0]!;
    fireEvent.change(path, { target: { value: "D:\\other" } });
    fireEvent.keyDown(path, { key: "Enter" });
    await waitFor(() => expect((path as HTMLInputElement).value).toBe("D:\\other"));
    const body = screen.getAllByRole("listbox")[0]!;
    fireEvent.keyDown(body, { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect((path as HTMLInputElement).value).toBe("C:\\work"));
    fireEvent.keyDown(body, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect((path as HTMLInputElement).value).toBe("D:\\other"));
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
    const path = screen.getAllByRole("textbox", { name: "Path" })[0]!;
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
      await waitFor(() =>
        expect(
          (screen.getAllByRole("textbox", { name: "Path" })[0] as HTMLInputElement).value,
        ).toBe("C:\\"),
      );
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
      expect(document.activeElement).toBe(local);
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
    expect(fsMock.openLocal).toHaveBeenCalledWith("C:\\work\\notes.txt");
    fireEvent.keyDown(local, { key: "ArrowUp", metaKey: true });
    await waitFor(() => expect(fsMock.list).toHaveBeenCalledWith({ kind: "local" }, "C:\\"));
  });
});
