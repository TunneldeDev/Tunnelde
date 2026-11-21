import { useEffect, useRef, useLayoutEffect, useMemo, type ReactNode } from "react";
import { createStore, useStore } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { events } from "@/lib/api/ipc";
import { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import { usePanelViewState } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { createFileIconResolver } from "@/lib/files/icons";
import { previewKind, matchesPreview } from "@/lib/files/preview";
import { sameSource } from "@/lib/files/dnd";
import { nativeEvents } from "@/lib/events/native";
import { domainEvents } from "@/lib/events/domain";
import type { FileViewPreferences } from "@/lib/files/view";
import type { FilePaneOptions } from "@/store/workspace";
import type { MountedFileAction } from "@/lib/plugins/mountFileMenu";
import type { SshSession } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import type { FileWindowModel, FileWindowCommand } from "./fileWindowModel";
import type { FilePageServices } from "./filePageServices";
import { createFileWindowPageFileSystem } from "./fileWindowFileSystem";
import { mainFilePageServices } from "./mainFilePageServices";

export function createFileWindowBinding(
  client: PanelWindowClient,
  record: WindowViewRecord,
  initial: FileWindowModel,
) {
  let disposed = false,
    encoded = JSON.stringify(initial),
    ready = false;
  const store = createStore(() => ({ model: initial }));
  const pendingReady = new Set<() => void>();
  const current = () => {
    const row = useWindowViews.getState().entries.get(record.panelId);
    if (disposed || row?.key !== record.key || row.controller !== record.controller || row.failed)
      throw new Error("panel.window.staleOwner");
    return row;
  };
  const target = () => {
    const row = current();
    return row.staged
      ? { kind: "staged" as const, id: row.key }
      : row.lease
        ? { kind: "owned" as const, lease: row.lease }
        : (() => {
            throw new Error("panel.window.staleOwner");
          })();
  };
  const owned = () => {
    const row = current();
    if (row.staged || row.moving || !row.lease) throw new Error("panel.window.staleOwner");
    return row.lease;
  };
  const action = <T,>(command: FileWindowCommand) =>
    client.action<T>(owned(), { kind: "files", command });
  const report = (error: unknown) => {
    if (!disposed) toast(translateError(error), "error");
  };
  const send = (command: FileWindowCommand) => {
    try {
      void action(command).catch(report);
    } catch (e) {
      report(e);
    }
  };
  const readyNow = (value: boolean) => {
    ready = value;
    if (ready) {
      for (const done of pendingReady) done();
      pendingReady.clear();
    }
  };
  const cleanup = new Set<() => void>();
  const deferred = new Map<string, FileWindowCommand>();
  const metadata = (command: FileWindowCommand) => {
    // Passive renderer metadata may settle after its layout cleanup. It must
    // never revive a retired view or turn unmount into a rendering exception.
    if (disposed) return;
    const row = current();
    if (row.staged || row.moving) {
      deferred.set(command.operation, command);
      return;
    }
    send(command);
  };
  const preferences = new Map<string, FileViewPreferences>();
  let rootsEncoded = "";

  const remoteActions = new Map<string, { pane: FilePaneOptions; title: string; sent: boolean }>();
  function RemotePicker({
    onClose,
    onConnected,
  }: Parameters<FilePageServices["FileRemoteDialog"]>[0]) {
    const callbacks = useRef({ onClose, onConnected });
    useLayoutEffect(() => {
      callbacks.current = { onClose, onConnected };
    });
    useEffect(() => {
      let dead = false;
      void (async () => {
        try {
          const session = await action<SshSession | null>({ operation: "pickRemote", data: {} });
          if (!session || dead) {
            if (!dead) callbacks.current.onClose();
            return;
          }
          // Main's completed action releases the rebind fence; wait for its
          // acknowledged source projection rather than racing an unbound read.
          const deadline = Date.now() + 10000;
          while (!dead && !store.getState().model.files.sessions.some((s) => s.id === session.id)) {
            if (Date.now() > deadline) throw new Error("ssh.sessionMissing");
            await new Promise((done) => setTimeout(done, 25));
          }
          if (!dead) {
            callbacks.current.onConnected(session);
            callbacks.current.onClose();
          }
        } catch (e) {
          if (!dead) {
            report(e);
            callbacks.current.onClose();
          }
        }
      })();
      return () => {
        dead = true;
      };
    }, []);
    return <div role="status" aria-busy="true" />;
  }
  const BuiltinSurface = ({ children }: { children: ReactNode }) => <>{children}</>;
  const services: FilePageServices = {
    rendered: readyNow,
    preserveDraftOnBlur: () => {
      const row = current();
      return row.staged || !!row.moving;
    },
    useModel() {
      const model = useStore(store, (s) => s.model.files);
      return {
        sessions: model.sessions,
        hosts: [],
        clip: model.clip,
        settings: model.preferences,
        highlights: useMemo(() => new Map(model.highlights), [model.highlights]),
        resolveFileIcon: createFileIconResolver(model.icons),
      };
    },
    getState() {
      const f = store.getState().model.files;
      return { sessions: f.sessions, clip: f.clip, settings: f.preferences, tabs: [f.tab] };
    },
    useViewState: <T,>(key: string, initialValue: T | (() => T)) =>
      usePanelViewState<T>(key, initialValue, (value): value is T => value !== undefined),
    fs: {
      ...createFileWindowPageFileSystem(client.files, target, owned),
      async openLocal(path) {
        await action({ operation: "openLocal", data: { path } });
      },
    },
    sameFilesystem(a, b) {
      if (sameSource(a, b)) return true;
      if (a.kind !== "remote" || b.kind !== "remote") return false;
      const sessions = store.getState().model.files.sessions;
      const first = sessions.find((s) => s.id === a.sessionId),
        second = sessions.find((s) => s.id === b.sessionId);
      return (
        !!first && !!second && first.hostId === second.hostId && first.address === second.address
      );
    },
    workspace: {
      setFileSession: (_id, sessionId, sessionIds = []) => {
        const tab = store.getState().model.files.tab;
        if (
          tab.fileSessionId === sessionId &&
          JSON.stringify(tab.fileSessionIds ?? []) === JSON.stringify(sessionIds)
        )
          return;
        metadata({ operation: "setSession", data: { sessionId, sessionIds } });
      },
      retainFilePane: (_id, pane, title) =>
        metadata({ operation: "retain", data: { pane, title } }),
      renameTab: (_id, title) => send({ operation: "rename", data: { title } }),
      openLocalEditor: (path) =>
        send({ operation: "editor", data: { source: { kind: "local" }, path } }),
      openFilePane(pane, title) {
        const id = crypto.randomUUID();
        const pending = { pane, title, sent: false };
        remoteActions.set(id, pending);
        queueMicrotask(() => {
          if (pending.sent) return;
          pending.sent = true;
          remoteActions.delete(id);
          send({ operation: "openPane", data: { pane, title } });
        });
        return id;
      },
      splitTab(id, direction) {
        const pending = remoteActions.get(id);
        if (!pending || pending.sent) throw new Error("panel.window.staleOwner");
        pending.sent = true;
        remoteActions.delete(id);
        send({
          operation: "openPane",
          data: { pane: pending.pane, title: pending.title, direction },
        });
      },
    },
    searchRoots: {
      publish(_id, roots) {
        const encoded = JSON.stringify(roots);
        if (encoded === rootsEncoded) return;
        rootsEncoded = encoded;
        metadata({ operation: "roots", data: { roots } });
      },
      remove() {
        /* Main retires panel-scoped roots with its resource, not an obsolete renderer. */
      },
    },
    confirm: (options) => {
      const lease = owned();
      void client
        .control<string>({ action: "beginInteraction", lease })
        .then((id) => {
          const release = () => {
            void client.control({ action: "endInteraction", lease, id }).catch(() => {});
          };
          try {
            owned();
          } catch {
            release();
            return;
          }
          const onConfirm = async () => {
            owned();
            await options.onConfirm();
          };
          useDialogs.getState().confirm({ ...options, onConfirm });
          const stop = useDialogs.subscribe((state) => {
            if (state.dialog.kind === "confirm" && state.dialog.onConfirm === onConfirm) return;
            stop();
            cleanup.delete(cancel);
            release();
          });
          const cancel = () => {
            stop();
            const dialog = useDialogs.getState().dialog;
            if (dialog.kind === "confirm" && dialog.onConfirm === onConfirm)
              useDialogs.getState().close();
            release();
          };
          cleanup.add(cancel);
        })
        .catch(report);
    },
    openConnect: () => send({ operation: "pickRemote", data: {} }),
    openEditor: (session, path) =>
      send({
        operation: "editor",
        data: { source: { kind: "remote", sessionId: session.id }, path },
      }),
    preview: (path, source) => send({ operation: "preview", data: { source, path } }),
    previewKind(path) {
      return (
        store.getState().model.files.previews.find((p) => matchesPreview(p, path))?.renderer ??
        previewKind(path)
      );
    },
    setClip(clip) {
      owned();
      store.setState((s) => ({ model: { ...s.model, files: { ...s.model.files, clip } } }));
      send({ operation: "clip", data: { clip } });
    },
    copyText: (text) => send({ operation: "clipboard", data: { text } }),
    watchCutCompletion(id, onDone, isRelevant = () => true) {
      let release: (() => void) | undefined;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        cleanup.delete(stop);
        release?.();
      };
      cleanup.add(stop);
      void events
        .onTransfer((event) => {
          if (stopped || disposed || event.id !== id) return;
          if (!isRelevant()) {
            stop();
            return;
          }
          if (event.status === "done") {
            stop();
            onDone();
          } else if (event.status === "cancelled" || event.status === "cleanupPending") stop();
        })
        .then((unlisten) => {
          release = unlisten;
          if (stopped || disposed) unlisten();
        })
        .catch((error) => {
          stop();
          report(error);
        });
    },
    fileMenuCommands(source, entry) {
      return store
        .getState()
        .model.files.menus.filter(
          (menu) =>
            menu.sources.includes(source.kind) &&
            menu.kinds.includes(entry.isDir ? "directory" : "file") &&
            (entry.isDir ||
              !menu.extensions?.length ||
              menu.extensions.some((ext) =>
                entry.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`),
              )),
        )
        .map((menu, index) => ({ ...menu.action, first: index === 0 }));
    },
    async runFileMenuCommand(selected, source, entry) {
      await action({ operation: "menuRun", data: { action: selected, source, entry } });
    },
    async discoverMountedFileActions(sessionId, path, onAction) {
      const actions = await action<MountedFileAction[]>({
        operation: "mountList",
        data: { sessionId, path },
      });
      for (const a of actions) onAction?.(a);
      return actions;
    },
    async revealMountedFile(selected, sessionId, path) {
      await action({ operation: "mountReveal", data: { action: selected, sessionId, path } });
    },
    events: {
      filesChanged: domainEvents.filesChanged,
      async onFiles(receive, signal) {
        const local = await domainEvents.onFiles(receive, signal);
        const native = await nativeEvents.on(
          "plugin://domain-changed",
          (payload) => {
            if (payload.domain !== "files" || signal.aborted) return;
            const source = payload.sessionId
              ? { kind: "remote" as const, sessionId: payload.sessionId }
              : { kind: "local" as const };
            if (
              source.kind === "remote" &&
              !store.getState().model.files.sessions.some((s) => s.id === source.sessionId)
            )
              return;
            receive({ source, origin: "native-worker" });
          },
          signal,
        );
        return () => {
          local();
          native();
        };
      },
    },
    windowLabel: () => "main",
    readPreferences: (key, defaults) =>
      preferences.get(key) ?? store.getState().model.files.views[key] ?? defaults,
    writePreferences(key, view) {
      preferences.set(key, view);
      send({ operation: "preference", data: { key, view } });
    },
    bindShortcuts: bindShortcutProvider,
    shortcutCandidates: scopedShortcutCandidates,
    async openLatestLog() {
      await action({ operation: "openLog", data: {} });
    },
    async revealLocalPath(path) {
      await action({ operation: "reveal", data: { path } });
    },
    async onNativeDrop(receive) {
      return getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        try {
          owned();
          const scale = window.devicePixelRatio || 1;
          receive(e.payload.paths, e.payload.position.x / scale, e.payload.position.y / scale);
        } catch {
          /* Frozen/staged owner is not an OS drop target. */
        }
      });
    },
    FileBrowserSurface:
      client.windowId === "main" ? mainFilePageServices.FileBrowserSurface : BuiltinSurface,
    FileRemoteDialog: RemotePicker,
  };
  if (client.windowId === "main") {
    services.fileMenuCommands = mainFilePageServices.fileMenuCommands;
    services.discoverMountedFileActions = mainFilePageServices.discoverMountedFileActions;
    services.revealMountedFile = mainFilePageServices.revealMountedFile;
  }
  return {
    services,
    activate() {
      const row = current();
      if (row.staged || row.moving) return;
      for (const command of deferred.values()) send(command);
      deferred.clear();
    },
    update(model: FileWindowModel) {
      const next = JSON.stringify(model);
      if (next !== encoded) {
        encoded = next;
        store.setState({ model });
      }
    },
    mount() {
      disposed = false;
      const unregister = record.controller.registerAsync(
        "fileReady",
        async () => {
          if (!ready) throw new Error("panel interaction in progress");
          return null;
        },
        () => (ready ? Promise.resolve() : new Promise<void>((done) => pendingReady.add(done))),
      );
      return unregister;
    },
    dispose() {
      disposed = true;
      for (const stop of cleanup) stop();
      cleanup.clear();
      for (const done of pendingReady) done();
      pendingReady.clear();
    },
  };
}
