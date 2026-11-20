import type { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import type { FileEntry, FsSource, Host, Settings, SshSession } from "@/lib/api/types";
import type { FileSystem } from "@/lib/files/fs";
import type { FileIconResolver } from "@/lib/files/icons";
import type { PasteClip } from "@/lib/files/dnd";
import type { FileViewPreferences } from "@/lib/files/view";
import type { FilesChanged } from "@/lib/events/domain";
import type { FileMenuContribution } from "@/lib/plugins/fileMenu";
import type { discoverMountedFileActions, revealMountedFile } from "@/lib/plugins/mountFileMenu";
import type { useWorkspace } from "@/store/workspace";
import type { useFileHighlights } from "@/store/fileHighlights";
import type { ConfirmOptions } from "@/store/dialogs";
import type { useViewState } from "@/lib/session/viewState";
import type { FileBrowserSurface } from "./FileBrowserSurface";
import type { FileRemoteDialog } from "./FileRemoteDialog";

export const filePagePreferenceKeys = [
  "filesShowHidden",
  "filesFoldersFirst",
  "filesSortBy",
  "filesSortDirection",
  "preloadDirs",
  "preloadCount",
  "lightweightMode",
] as const satisfies readonly (keyof Settings)[];
export type FilePagePreferences = Pick<Settings, (typeof filePagePreferenceKeys)[number]>;
export function filePagePreferenceProjection(settings: Settings): FilePagePreferences {
  return Object.fromEntries(
    filePagePreferenceKeys.map((key) => [key, settings[key]]),
  ) as FilePagePreferences;
}
type Workspace = ReturnType<typeof useWorkspace.getState>;
export interface FilePageModel {
  sessions: SshSession[];
  hosts: Host[];
  clip: PasteClip | null;
  settings: FilePagePreferences;
  highlights: ReturnType<typeof useFileHighlights.getState>["bySource"];
  resolveFileIcon: FileIconResolver;
}
/** Owner-supplied boundary, not a public plugin capability. A satellite must
 * provide scoped read models and leased effects, never writable main stores.
 * The service identity/hook implementations stay fixed for a renderer lifetime. */
export interface FilePageServices {
  useModel(): FilePageModel;
  getState(): Pick<FilePageModel, "sessions" | "clip" | "settings"> & { tabs: Workspace["tabs"] };
  useViewState: typeof useViewState;
  fs: FileSystem;
  sameFilesystem(left: FsSource, right: FsSource): boolean;
  workspace: Pick<
    Workspace,
    | "setFileSession"
    | "retainFilePane"
    | "renameTab"
    | "openFilePane"
    | "splitTab"
    | "openLocalEditor"
  >;
  searchRoots: {
    publish(
      id: string,
      roots: { id: string; tabId: string; path: string; sessionId: string | null }[],
    ): void;
    remove(id: string): void;
  };
  confirm(options: ConfirmOptions): void;
  openConnect(host: Host, after: "sftp"): void;
  openEditor(session: SshSession, path: string): void;
  preview(path: string, source: FsSource): void;
  previewKind(path: string): string;
  setClip(clip: PasteClip | null): void;
  copyText(text: string): void;
  watchCutCompletion(id: string, onDone: () => void, isRelevant: () => boolean): void;
  fileMenuCommands(source: FsSource, entry: FileEntry): FileMenuContribution[];
  runFileMenuCommand(
    action: FileMenuContribution,
    source: FsSource,
    entry: FileEntry,
  ): Promise<void>;
  discoverMountedFileActions: typeof discoverMountedFileActions;
  revealMountedFile: typeof revealMountedFile;
  events: {
    onFiles(receive: (payload: FilesChanged) => void, signal: AbortSignal): Promise<() => void>;
    filesChanged(payload: FilesChanged): void;
  };
  windowLabel(): string;
  readPreferences(key: string, defaults: FileViewPreferences): FileViewPreferences;
  writePreferences(key: string, view: FileViewPreferences): void;
  bindShortcuts: typeof bindShortcutProvider;
  shortcutCandidates: typeof scopedShortcutCandidates;
  openLatestLog(): Promise<void>;
  revealLocalPath(path: string): Promise<void>;
  onNativeDrop(receive: (paths: string[], x: number, y: number) => void): Promise<() => void>;
  FileBrowserSurface: typeof FileBrowserSurface;
  FileRemoteDialog: typeof FileRemoteDialog;
}
