import { usePlugins } from "@/store/plugins";
import { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, isTauri } from "@/lib/api/ipc";
import { fs } from "@/lib/files/fs";
import { useFileIconResolver } from "@/lib/files/icons";
import { sameSource } from "@/lib/files/dnd";
import { watchCutCompletion } from "@/lib/files/cutCompletion";
import { readFileViewPreferences, writeFileViewPreferences } from "@/lib/files/preferences";
import { matchesPreview, previewKind, previewProviders } from "@/lib/files/preview";
import { domainEvents } from "@/lib/events/domain";
import { fileMenuCommands, runFileMenuCommand } from "@/lib/plugins/fileMenu";
import { discoverMountedFileActions, revealMountedFile } from "@/lib/plugins/mountFileMenu";
import { copyText } from "@/lib/session/clipboard";
import { useViewState } from "@/lib/session/viewState";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useSearchRoots } from "@/store/searchRoots";
import { useFileClipboard } from "@/store/fileClipboard";
import { useFilePreview } from "@/store/filePreview";
import { useFileHighlights } from "@/store/fileHighlights";
import { FileBrowserSurface } from "./FileBrowserSurface";
import { FileRemoteDialog } from "./FileRemoteDialog";
import { filePagePreferenceProjection, type FilePageServices } from "./filePageServices";

/** The main coordinator owns these effects. Shared rendering never imports
 * this module; a native adapter must supply its own authority and read models. */
export const mainFilePageServices: FilePageServices = {
  useModel() {
    return {
      sessions: useSsh((state) => state.sessions),
      hosts: useHosts((state) => state.hosts),
      clip: useFileClipboard((state) => state.clip),
      settings: filePagePreferenceProjection(useSettings((state) => state.settings)),
      highlights: useFileHighlights((state) => state.bySource),
      resolveFileIcon: useFileIconResolver(),
    };
  },
  getState: () => ({
    sessions: useSsh.getState().sessions,
    clip: useFileClipboard.getState().clip,
    settings: filePagePreferenceProjection(useSettings.getState().settings),
    tabs: useWorkspace.getState().tabs,
  }),
  useViewState,
  fs,
  sameFilesystem(left, right) {
    if (sameSource(left, right)) return true;
    if (left.kind !== "remote" || right.kind !== "remote") return false;
    const sessions = useSsh.getState().sessions;
    const a = sessions.find((item) => item.id === left.sessionId);
    const b = sessions.find((item) => item.id === right.sessionId);
    return !!a && !!b && a.hostId === b.hostId && a.address === b.address;
  },
  workspace: {
    setFileSession: (...args) => useWorkspace.getState().setFileSession(...args),
    retainFilePane: (...args) => useWorkspace.getState().retainFilePane(...args),
    renameTab: (...args) => useWorkspace.getState().renameTab(...args),
    openFilePane: (...args) => useWorkspace.getState().openFilePane(...args),
    splitTab: (...args) => useWorkspace.getState().splitTab(...args),
    openLocalEditor: (...args) => useWorkspace.getState().openLocalEditor(...args),
  },
  searchRoots: {
    publish: (...args) => useSearchRoots.getState().publish(...args),
    remove: (...args) => useSearchRoots.getState().remove(...args),
  },
  confirm: (options) => useDialogs.getState().confirm(options),
  openConnect: (host, after) => useDialogs.getState().openConnect(host, after),
  openEditor: (session, path) => useWorkspace.getState().openEditor(session, path),
  preview: (path, source) => useFilePreview.getState().show(path, 0, 0, source),
  previewKind(path) {
    const provider = previewProviders(usePlugins.getState().items).find((item) =>
      matchesPreview(item, path),
    );
    return provider?.renderer ?? previewKind(path);
  },
  setClip: (clip) => useFileClipboard.getState().set(clip),
  copyText: (text) => copyText(text),
  watchCutCompletion: (...args) => watchCutCompletion(...args),
  fileMenuCommands: (source, entry) => fileMenuCommands(usePlugins.getState().items, source, entry),
  runFileMenuCommand: (...args) => runFileMenuCommand(...args),
  discoverMountedFileActions: (...args) => discoverMountedFileActions(...args),
  revealMountedFile: (...args) => revealMountedFile(...args),
  events: domainEvents,
  windowLabel() {
    try {
      return isTauri() ? getCurrentWebview().label : "main";
    } catch {
      return "main";
    }
  },
  readPreferences: readFileViewPreferences,
  writePreferences: writeFileViewPreferences,
  bindShortcuts: bindShortcutProvider,
  shortcutCandidates: scopedShortcutCandidates,
  openLatestLog: () => api.openLatestLog(),
  revealLocalPath: (path) => api.revealLocalPath(path),
  async onNativeDrop(receive) {
    if (!isTauri()) return () => {};
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const scale = window.devicePixelRatio || 1;
      receive(
        event.payload.paths,
        event.payload.position.x / scale,
        event.payload.position.y / scale,
      );
    });
  },
  FileBrowserSurface,
  FileRemoteDialog,
};
