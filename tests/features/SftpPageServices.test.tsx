import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { SftpPageView } from "@/features/sftp/SftpPageView";
import {
  filePagePreferenceProjection,
  type FilePageServices,
} from "@/features/sftp/filePageServices";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { api } from "@/lib/api/ipc";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import type { FileEntry, FsSource, Listing } from "@/lib/api/types";
function fixture() {
  const session = {
    id: "scoped",
    hostId: "host",
    title: "Scoped session",
    address: "qa@host:22",
    cols: 80,
    rows: 24,
    connectedAt: 0,
  };
  const model = {
    sessions: [session],
    hosts: [],
    clip: null,
    settings: { ...filePagePreferenceProjection(DEFAULT_SETTINGS), preloadDirs: false },
    highlights: new Map(),
    resolveFileIcon: () => undefined,
  };
  const entry: FileEntry = {
    name: "owned.txt",
    path: "/owned/owned.txt",
    isDir: false,
    isHidden: false,
    size: 5,
    modified: null,
    permissions: null,
  };
  const list = vi.fn(async (_source: FsSource, path?: string | null): Promise<Listing> => ({
    path: path ?? "/owned",
    entries: [entry],
  }));
  const effect = vi.fn(),
    setFileSession = vi.fn(),
    publish = vi.fn(),
    openLocalEditor = vi.fn();
  const services: FilePageServices = {
    useModel: () => model,
    getState: () => ({ ...model, tabs: [] }),
    useViewState(_key, initial) {
      return useState(initial);
    },
    fs: {
      list,
      home: async () => "/owned",
      mkdir: effect,
      createFile: effect,
      rename: effect,
      remove: effect,
      copy: effect,
      transfer: vi.fn(),
      readText: vi.fn(),
      writeText: effect,
      openLocal: effect,
    },
    sameFilesystem: (a, b) =>
      a.kind === b.kind &&
      (a.kind === "local" || (b.kind === "remote" && a.sessionId === b.sessionId)),
    workspace: {
      setFileSession,
      retainFilePane: vi.fn(),
      renameTab: vi.fn(),
      openFilePane: vi.fn(),
      splitTab: vi.fn(),
      openLocalEditor,
    },
    searchRoots: { publish, remove: vi.fn() },
    confirm: vi.fn(),
    openConnect: vi.fn(),
    openEditor: vi.fn(),
    preview: vi.fn(),
    previewKind: () => "text",
    setClip: vi.fn(),
    copyText: vi.fn(),
    watchCutCompletion: vi.fn(),
    fileMenuCommands: () => [],
    runFileMenuCommand: vi.fn(),
    discoverMountedFileActions: vi.fn(),
    revealMountedFile: vi.fn(),
    events: { onFiles: vi.fn().mockResolvedValue(vi.fn()), filesChanged: vi.fn() },
    windowLabel: () => "isolated",
    readPreferences: (_key, defaults) => defaults,
    writePreferences: vi.fn(),
    bindShortcuts: () => () => {},
    shortcutCandidates: () => [],
    openLatestLog: effect,
    revealLocalPath: effect,
    onNativeDrop: vi.fn().mockResolvedValue(vi.fn()),
    FileBrowserSurface: ({ children }) => <>{children}</>,
    FileRemoteDialog: () => <></>,
  };
  return { services, list, setFileSession, publish, openLocalEditor };
}
it("renders a scoped session with no hydration or fallback to main stores/IPC", async () => {
  const f = fixture();
  const beforeSessions = useSsh.getState().sessions;
  const beforeTabs = useWorkspace.getState().tabs;
  const fallback = vi.spyOn(api, "sftpList").mockRejectedValue(new Error("unscoped I/O"));
  render(
    <SftpPageView
      services={f.services}
      sessionId="scoped"
      tabId="sftp:scoped"
      single={{
        ownerSessionId: "scoped",
        source: { kind: "remote", sessionId: "scoped" },
        path: "/owned",
      }}
    />,
  );
  await screen.findByText("owned.txt");
  expect(f.list).toHaveBeenCalledWith({ kind: "remote", sessionId: "scoped" }, "/owned");
  expect(f.setFileSession).toHaveBeenCalledWith("sftp:scoped", "scoped", ["scoped"]);
  expect(useSsh.getState().sessions).toBe(beforeSessions);
  expect(useWorkspace.getState().tabs).toBe(beforeTabs);
  expect(fallback).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByText("owned.txt"));
  expect(f.services.openEditor).toHaveBeenCalledWith(
    expect.objectContaining({ id: "scoped" }),
    "/owned/owned.txt",
  );
});
it("uses the injected listing backend for breadcrumb folder menus", async () => {
  const f = fixture();
  const fallback = vi.spyOn(api, "localList").mockRejectedValue(new Error("unscoped I/O"));
  render(
    <SftpPageView
      services={f.services}
      sessionId="scoped"
      single={{ ownerSessionId: "scoped", source: { kind: "local" }, path: "/owned" }}
    />,
  );
  await screen.findByText("owned.txt");
  const before = f.list.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Subfolders of /owned" }));
  await waitFor(() => expect(f.list.mock.calls.length).toBeGreaterThan(before));
  expect(fallback).not.toHaveBeenCalled();
});
it("only projects file-view preferences, excluding credentials, providers and unrelated settings", () => {
  const projected = filePagePreferenceProjection(DEFAULT_SETTINGS);
  expect(Object.keys(projected).sort()).toEqual([
    "filesFoldersFirst",
    "filesShowHidden",
    "filesSortBy",
    "filesSortDirection",
    "lightweightMode",
    "preloadCount",
    "preloadDirs",
  ]);
  expect(projected).not.toHaveProperty("proxyProfiles");
  expect(projected).not.toHaveProperty("uiProviders");
});
