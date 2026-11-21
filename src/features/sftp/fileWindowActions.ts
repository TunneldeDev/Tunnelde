import type { PanelLease } from "@/lib/panels/windowProtocol";
import type { FileWindowCommand } from "./fileWindowModel";
import type { FsSource, FileEntry } from "@/lib/api/types";
import type { FilePaneOptions } from "@/store/workspace";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useFileClipboard } from "@/store/fileClipboard";
import { useFilePreview } from "@/store/filePreview";
import { useSearchRoots } from "@/store/searchRoots";
import { usePlugins } from "@/store/plugins";
import { api } from "@/lib/api/ipc";
import { fileMenuCommands, runFileMenuCommand } from "@/lib/plugins/fileMenu";
import { discoverMountedFileActions, revealMountedFile } from "@/lib/plugins/mountFileMenu";
import { useFileWindowRegistrations } from "./fileWindowRegistration";
import { fileWindowViews } from "./fileWindowPublication";
import { writeFileViewPreferences } from "@/lib/files/preferences";
import { pickFileWindowRemote } from "./fileWindowPicker";
const invalid = () => {
  throw new Error("panel.window.staleOwner");
};
function text(value: unknown, max = 32768): asserts value is string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) invalid();
}
export async function executeFileWindowAction(
  lease: PanelLease,
  command: FileWindowCommand,
  show: () => Promise<unknown>,
) {
  const tab = useWorkspace.getState().tabs.find((t) => t.kind === "sftp" && t.id === lease.panelId);
  const registration = useFileWindowRegistrations.getState().entries.get(lease.panelId);
  if (!tab || !registration) return invalid();
  const source = (s: FsSource) => {
    if (
      !s ||
      !registration.sources.some(
        (a) =>
          a.kind === s.kind &&
          (a.kind === "local" || (s.kind === "remote" && a.sessionId === s.sessionId)),
      )
    )
      invalid();
    if (
      s.kind === "remote" &&
      !useSsh.getState().sessions.some((a) => a.id === s.sessionId && !a.purpose)
    )
      invalid();
    return s;
  };
  const entry = (s: FsSource, e: FileEntry) => {
    source(s);
    text(e.path);
    text(e.name, 4096);
    if (typeof e.isDir !== "boolean") invalid();
    return e;
  };
  const pane = (p: FilePaneOptions): FilePaneOptions => {
    source(p.source);
    if (p.path !== null) text(p.path);
    text(p.ownerSessionId, 128);
    const remote =
      p.source.kind === "remote"
        ? useSsh
            .getState()
            .sessions.find((s) => s.id === (p.source as { sessionId: string }).sessionId)
        : undefined;
    return {
      source: p.source,
      path: p.path,
      ownerSessionId: p.ownerSessionId,
      view: p.view,
      ...(remote ? { remoteIdentity: { hostId: remote.hostId, address: remote.address } } : {}),
    };
  };
  switch (command.operation) {
    case "preference": {
      if (!Object.hasOwn(fileWindowViews(tab.id), command.data.key)) invalid();
      const v = command.data.view;
      if (
        !v ||
        typeof v !== "object" ||
        typeof v.filesShowHidden !== "boolean" ||
        typeof v.filesFoldersFirst !== "boolean" ||
        !["name", "size", "modified", "type"].includes(v.filesSortBy) ||
        !["asc", "desc"].includes(v.filesSortDirection)
      )
        invalid();
      writeFileViewPreferences(command.data.key, v);
      return null;
    }
    case "pickRemote":
      await show();
      return pickFileWindowRemote();
    case "openLog":
      await api.openLatestLog();
      return null;
    case "clipboard":
      text(command.data.text, 2 * 1024 * 1024);
      await api.clipboardWriteText(command.data.text);
      return null;
    case "clip": {
      const clip = command.data.clip;
      if (clip) {
        source(clip.source);
        if (
          !["copy", "cut"].includes(clip.action) ||
          !Array.isArray(clip.items) ||
          clip.items.length > 10000
        )
          invalid();
        for (const item of clip.items) {
          text(item.path);
          text(item.name, 4096);
          if (typeof item.isDir !== "boolean") invalid();
        }
      }
      useFileClipboard.getState().set(clip);
      return null;
    }
    case "editor":
    case "preview": {
      const s = source(command.data.source);
      text(command.data.path);
      await show();
      if (command.operation === "preview")
        useFilePreview.getState().show(command.data.path, 0, 0, s);
      else if (s.kind === "local") useWorkspace.getState().openLocalEditor(command.data.path);
      else {
        const session = useSsh.getState().sessions.find((a) => a.id === s.sessionId);
        if (!session) invalid();
        useWorkspace.getState().openEditor(session!, command.data.path);
      }
      return null;
    }
    case "openLocal":
      source({ kind: "local" });
      text(command.data.path);
      await api.openLocalPath(command.data.path);
      return null;
    case "reveal":
      source({ kind: "local" });
      text(command.data.path);
      await api.revealLocalPath(command.data.path);
      return null;
    case "rename":
      text(command.data.title, 4096);
      useWorkspace.getState().renameTab(tab.id, command.data.title);
      return null;
    case "setSession": {
      const { sessionId, sessionIds } = command.data;
      if (!Array.isArray(sessionIds) || sessionIds.length > 2) invalid();
      for (const id of [sessionId, ...sessionIds])
        if (id !== null) source({ kind: "remote", sessionId: id });
      useWorkspace.getState().setFileSession(tab.id, sessionId, sessionIds);
      return null;
    }
    case "retain":
      text(command.data.title, 4096);
      useWorkspace.getState().retainFilePane(tab.id, pane(command.data.pane), command.data.title);
      return null;
    case "openPane": {
      text(command.data.title, 4096);
      if (command.data.direction && !["row", "column"].includes(command.data.direction)) invalid();
      const id = useWorkspace.getState().openFilePane(pane(command.data.pane), command.data.title);
      if (command.data.direction) {
        if (!["row", "column"].includes(command.data.direction)) invalid();
        useWorkspace.getState().splitTab(id, command.data.direction);
      }
      return id;
    }
    case "roots": {
      const roots = command.data.roots;
      if (!Array.isArray(roots) || roots.length > 2) invalid();
      for (const root of roots) {
        text(root.id, 256);
        text(root.path);
        if (root.sessionId !== null) source({ kind: "remote", sessionId: root.sessionId });
        else source({ kind: "local" });
      }
      useSearchRoots.getState().publish(
        `native-files:${tab.id}`,
        roots.map((root) => ({ ...root, tabId: tab.id })),
      );
      return null;
    }
    case "menuList":
      return fileMenuCommands(
        usePlugins.getState().items,
        source(command.data.source),
        entry(command.data.source, command.data.entry),
      );
    case "menuRun": {
      const { action } = command.data;
      const s = source(command.data.source),
        e = entry(s, command.data.entry);
      const current = fileMenuCommands(usePlugins.getState().items, s, e).find(
        (a) =>
          a.pluginId === action.pluginId &&
          a.command === action.command &&
          a.fingerprint === action.fingerprint,
      );
      if (!current) invalid();
      await show();
      await runFileMenuCommand(current!, s, e);
      return null;
    }
    case "mountList":
      source({ kind: "remote", sessionId: command.data.sessionId });
      text(command.data.path);
      return discoverMountedFileActions(command.data.sessionId, command.data.path);
    case "mountReveal": {
      const { sessionId, path, action } = command.data;
      source({ kind: "remote", sessionId });
      text(path);
      const current = (await discoverMountedFileActions(sessionId, path)).find(
        (a) =>
          a.pluginId === action.pluginId &&
          a.fingerprint === action.fingerprint &&
          a.mount.id === action.mount.id,
      );
      if (!current) invalid();
      await revealMountedFile(current!, sessionId, path);
      return null;
    }
  }
}
