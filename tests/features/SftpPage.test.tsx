// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

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
import type { FsSource, SshSession } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useTransfers } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";
import { useFileClipboard } from "@/store/fileClipboard";
import { DRAG_MIME } from "@/lib/files/dnd";

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
      size: 12,
      modified: null,
      permissions: null,
    },
    { name: "src", path: "C:\\work\\src", isDir: true, size: 0, modified: null, permissions: null },
  ],
};

const remoteListing = {
  path: "/srv/app",
  entries: [
    {
      name: "readme.md",
      path: "/srv/app/readme.md",
      isDir: false,
      size: 20,
      modified: null,
      permissions: null,
    },
  ],
};

const listingFor = (source: FsSource) => (source.kind === "local" ? localListing : remoteListing);

beforeEach(() => {
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
    fireEvent.keyDown(body, { key: "ArrowDown", shiftKey: true });
    expect(within(body).getAllByRole("option", { selected: true })).toHaveLength(2);
    fireEvent.keyDown(body, { key: "ArrowUp", shiftKey: true });
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
});
