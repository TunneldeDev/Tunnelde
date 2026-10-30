// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useTransfers } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";

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
    { name: "notes.txt", path: "C:\\work\\notes.txt", isDir: false, size: 12, modified: null, permissions: null },
    { name: "src", path: "C:\\work\\src", isDir: true, size: 0, modified: null, permissions: null },
  ],
};

const remoteListing = {
  path: "/srv/app",
  entries: [
    { name: "readme.md", path: "/srv/app/readme.md", isDir: false, size: 20, modified: null, permissions: null },
  ],
};

const listingFor = (source: FsSource) =>
  source.kind === "local" ? localListing : remoteListing;

beforeEach(() => {
  fsMock.list.mockReset();
  fsMock.rename.mockReset().mockResolvedValue(undefined);
  fsMock.createFile.mockReset().mockResolvedValue(undefined);
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  fsMock.transfer.mockReset().mockResolvedValue("transfer-1");
  fsMock.openLocal.mockReset().mockResolvedValue(undefined);
  fsMock.list.mockImplementation(async (source: FsSource, path?: string | null) => {
    const listing = listingFor(source);
    return path ? { ...listing, path } : listing;
  });

  useSsh.setState({ sessions: [session] });
  useHosts.setState({ hosts: [] });
  useDialogs.setState({ confirm: vi.fn(), openConnect: vi.fn() });
  useWorkspace.setState({ openEditor: vi.fn() });
  useTransfers.setState({ items: [] });
});

describe("SftpPage", () => {
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
      );
    });
  });

  it("transfers a whole selection", async () => {
    render(<SftpPage sessionId="session-1" />);
    const notes = (await screen.findByText("notes.txt")).closest(".sftp-row") as HTMLElement;
    const source = (await screen.findByText("src")).closest(".sftp-row") as HTMLElement;

    fireEvent.click(notes);
    fireEvent.click(source, { ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();

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
    );
  });

  it("selects everything with the keyboard", async () => {
    render(<SftpPage sessionId="session-1" />);
    await screen.findByText("notes.txt");
    const local = screen.getAllByRole("listbox")[0] as HTMLElement;
    fireEvent.keyDown(local, { key: "a", ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
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
