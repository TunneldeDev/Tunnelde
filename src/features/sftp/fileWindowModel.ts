import type { WindowModelAppearance } from "@/app/panelReadModels";
import type { FilePagePreferences } from "./filePageServices";
import type { SftpPageProps } from "./SftpPage";
import type {
  SshSession,
  PluginFileIconTheme,
  PluginFilePreview,
  FsSource,
  FileEntry,
  Settings,
} from "@/lib/api/types";
import type { WorkspaceTab, FilePaneOptions } from "@/store/workspace";
import type { PasteClip } from "@/lib/files/dnd";
import type { FileMenuContribution } from "@/lib/plugins/fileMenu";
import type { MountedFileAction } from "@/lib/plugins/mountFileMenu";
import type { OwnedFileHighlight } from "@/lib/plugins/fileHighlights";
import type { FileViewPreferences } from "@/lib/files/view";
export interface FileWindowModel extends WindowModelAppearance {
  files: {
    props: SftpPageProps;
    tab: WorkspaceTab;
    sessions: SshSession[];
    clip: PasteClip | null;
    preferences: FilePagePreferences;
    shortcuts: Pick<Settings, "keyboardShortcuts" | "shortcutRules">;
    views: Record<string, FileViewPreferences>;
    highlights: Array<[string, OwnedFileHighlight[]]>;
    icons?: PluginFileIconTheme;
    previews: PluginFilePreview[];
    menus: Array<{
      sources: Array<"local" | "remote">;
      kinds: Array<"file" | "directory">;
      extensions?: string[];
      action: FileMenuContribution;
    }>;
    providersSelected: boolean;
  };
}
export type FileWindowCommand =
  | { operation: "preference"; data: { key: string; view: FileViewPreferences } }
  | { operation: "clipboard"; data: { text: string } }
  | { operation: "clip"; data: { clip: PasteClip | null } }
  | { operation: "pickRemote" | "openLog"; data: Record<string, never> }
  | {
      operation: "editor" | "preview";
      data: {
        source: FsSource;
        path: string;
        browser?: { id: string; paths: string[] };
        follow?: boolean;
      };
    }
  | { operation: "reveal" | "openLocal"; data: { path: string } }
  | { operation: "setSession"; data: { sessionId: string | null; sessionIds: string[] } }
  | { operation: "rename"; data: { title: string } }
  | { operation: "retain"; data: { pane: FilePaneOptions; title: string } }
  | {
      operation: "openPane";
      data: { pane: FilePaneOptions; title: string; direction?: "row" | "column" };
    }
  | {
      operation: "roots";
      data: { roots: { id: string; tabId: string; path: string; sessionId: string | null }[] };
    }
  | { operation: "menuList"; data: { source: FsSource; entry: FileEntry } }
  | {
      operation: "menuRun";
      data: { source: FsSource; entry: FileEntry; action: FileMenuContribution };
    }
  | { operation: "mountList"; data: { sessionId: string; path: string } }
  | {
      operation: "mountReveal";
      data: { sessionId: string; path: string; action: MountedFileAction };
    };
