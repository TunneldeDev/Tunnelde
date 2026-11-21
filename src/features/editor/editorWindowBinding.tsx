import { useEffect, useLayoutEffect, useState } from "react";
import { createStore, useStore } from "zustand";
import { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { EditorSelectionSnapshot, EditorDocument } from "@/store/editors";
import { useEditors, editorHasPendingChanges } from "@/store/editors";
import i18n from "@/i18n/i18n";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import type { EditorPageServices } from "./editorPageServices";
import type {
  EditorWindowModel,
  EditorWindowCommand,
  EditorPatch,
  EditorWindowAck,
} from "./editorWindowModel";
import { editorPatch } from "./editorWindowModel";
import { mainEditorPageServices } from "./mainEditorPageServices";
import type { EditorVisibleRange, EditorToken } from "./syntax/useCodeEditorSyntax";
function invalid(): never {
  throw new Error("panel.window.staleOwner");
}
function isSelection(value: unknown): value is EditorSelectionSnapshot {
  const s = value as EditorSelectionSnapshot | null;
  return (
    !!s &&
    Number.isInteger(s.start) &&
    Number.isInteger(s.end) &&
    s.start >= 0 &&
    s.end >= s.start &&
    ["forward", "backward", "none"].includes(s.direction) &&
    [s.scrollTop, s.scrollLeft].every((n) => n === undefined || (Number.isFinite(n) && n >= 0))
  );
}
export function createEditorWindowBinding(
  client: PanelWindowClient,
  record: WindowViewRecord,
  initial: EditorWindowModel,
) {
  let disposed = false,
    ready = false,
    composing = false,
    busy = false,
    uiBlocked = false,
    recovered = false,
    failure: string | undefined;
  let canonical = initial,
    selection: EditorSelectionSnapshot | null =
      record.controller.read("editor.selection", isSelection) ?? null;
  let readSelection = () => selection;
  let readFocused = () => false,
    wantsFocus = false;
  let before: EditorSelectionSnapshot | null = null,
    inputType = "insertText";
  let compositionBase: string | undefined,
    compositionSelection: EditorSelectionSnapshot | null = null;
  let restore: EditorSelectionSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, draining: Promise<void> | undefined;
  const edits: EditorPatch[] = [];
  const store = createStore(() => ({
    model: initial,
    frozen: record.staged,
    failure: undefined as string | undefined,
  }));
  const expected = record.controller.read(
    "editor.revision",
    (v): v is { documentId: string; version: number } =>
      !!v &&
      typeof (v as { documentId?: unknown }).documentId === "string" &&
      Number.isInteger((v as { version?: unknown }).version),
  );
  const waiters = new Set<() => void>();
  const current = () => {
    const row = useWindowViews.getState().entries.get(record.panelId);
    if (disposed || row?.key !== record.key || row.controller !== record.controller || row.failed)
      invalid();
    return row;
  };
  const owned = (allowMoving = false) => {
    const row = current();
    if (row.staged || (!allowMoving && row.moving) || !row.lease) invalid();
    return row.lease;
  };
  const publish = () => {
    const row = current();
    store.setState({ frozen: !!row.staged || !!row.moving || busy || !!failure, failure });
  };
  const report = (e: unknown) => {
    if (!disposed) toast(translateError(e), "error");
  };
  const fail = (e: unknown) => {
    failure = translateError(e);
    if (!disposed) publish();
    throw e;
  };
  const update = (model: EditorWindowModel) => {
    canonical = model;
    const local = store.getState().model;
    // Incoming publication must not erase input newer than the last acknowledgement.
    if (
      edits.length ||
      draining ||
      composing ||
      failure ||
      (model.editor.entry?.documentId === local.editor.entry?.documentId &&
        (model.editor.entry?.version ?? -1) < (local.editor.entry?.version ?? -1))
    ) {
      store.setState({
        model: { ...model, editor: { ...model.editor, entry: local.editor.entry } },
      });
    } else store.setState({ model });
    if (!disposed) publish();
  };
  const cas = () => {
    const entry = store.getState().model.editor.entry;
    if (!entry) invalid();
    return {
      documentId: entry.documentId,
      version: entry.version,
      encoding: entry.encoding ?? "utf-8",
    };
  };
  const refresh = async (minimum?: EditorWindowAck) => {
    for (let i = 0; i < 100; i++) {
      const model = await client.control<EditorWindowModel>({
        action: "readModel",
        lease: owned(true),
      });
      const entry = model.editor.entry;
      if (
        !minimum ||
        (entry?.documentId === minimum.documentId && (entry.version ?? -1) >= minimum.version)
      ) {
        if (!disposed) update(model);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("panel.window.timeout");
  };
  const flush = (): Promise<void> => {
    if (failure) return recovered ? Promise.resolve() : Promise.reject(new Error(failure));
    if (composing) return Promise.reject(new Error("panel.window.moveInProgress"));
    clearTimeout(timer);
    if (draining) return draining;
    if (!edits.length) return Promise.resolve();
    const work = (async () => {
      while (edits.length) {
        const batch = edits.splice(0, 256);
        const entry = store.getState().model.editor.entry;
        if (!entry?.documentId || entry.version === undefined) invalid();
        // The local version includes both queued and the current admitted batch.
        const version = entry.version - edits.length - batch.length;
        try {
          const ack = await client.action<EditorWindowAck>(owned(true), {
            kind: "editor",
            command: {
              operation: "edit",
              data: {
                documentId: entry.documentId,
                version,
                encoding: entry.encoding ?? "utf-8",
                edits: batch,
              },
            },
          });
          if (ack.documentId !== entry.documentId || ack.version !== version + batch.length)
            invalid();
        } catch (e) {
          edits.unshift(...batch);
          busy = true;
          publish();
          try {
            const draft = store.getState().model.editor.entry;
            if (!draft) invalid();
            await client.action(owned(true), {
              kind: "editor",
              command: {
                operation: "recover",
                data: {
                  content: draft.content,
                  encoding: draft.encoding ?? "utf-8",
                  bom: draft.bom ?? false,
                },
              },
            });
            recovered = true;
            edits.splice(0);
            toast(i18n.t("editor.recoveredDraft"), "success");
          } catch {
            /* Keep the local draft and movement barrier if backup fails. */
          }
          busy = false;
          fail(e);
        }
      }
    })();
    draining = work;
    void work
      .finally(() => {
        if (draining === work) draining = undefined;
        // Use the latest canonical projection only after it has caught up. A stale
        // publication can arrive between action completion and the next model tick.
        const local = store.getState().model.editor.entry,
          latest = canonical.editor.entry;
        if (
          !disposed &&
          !edits.length &&
          !failure &&
          latest?.documentId === local?.documentId &&
          latest?.version === local?.version
        )
          update(canonical);
      })
      .catch(() => {});
    return work;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch(report);
    }, 40);
  };
  const action = async <T,>(
    operation: EditorWindowCommand["operation"],
    data: Record<string, unknown> = {},
  ): Promise<T> => {
    owned();
    await flush();
    if (disposed || failure) invalid();
    if (operation === "syntax")
      return client.action<T>(owned(), {
        kind: "editor",
        command: { operation, data: { ...cas(), ...data } },
      });
    wantsFocus = readFocused();
    busy = true;
    publish();
    try {
      const result = await client.action<T>(owned(), {
        kind: "editor",
        command: { operation, data: { ...cas(), ...data } },
      });
      if (operation === "undo") restore = (result as EditorWindowAck).selection ?? null;
      await refresh(operation === "undo" ? (result as EditorWindowAck) : undefined);
      return result;
    } finally {
      busy = false;
      if (!disposed) publish();
    }
  };
  const send = (operation: EditorWindowCommand["operation"], data?: Record<string, unknown>) => {
    void action(operation, data).catch(report);
  };
  const editable = () => {
    owned();
    if (busy || failure) invalid();
  };
  const addChange = (content: string, after: EditorSelectionSnapshot | null) => {
    editable();
    const model = store.getState().model,
      entry = model.editor.entry;
    if (!entry || entry.content === content) return;
    if (!composing) {
      edits.push({
        ...editorPatch(entry.content, content),
        inputType,
        before: before ?? selection,
        after,
      });
      before = null;
    }
    store.setState({
      model: {
        ...model,
        editor: {
          ...model.editor,
          entry: { ...entry, content, version: (entry.version ?? 0) + (composing ? 0 : 1) },
        },
      },
    });
    selection = after;
    record.controller.invalidate();
    if (!composing) schedule();
  };
  const services: EditorPageServices = {
    useModel() {
      const s = useStore(store);
      return { ...s.model.editor, frozen: s.frozen, syncFailure: s.failure };
    },
    useSyntax(document, enabled, inComposition) {
      const documentId = document?.documentId,
        version = document?.version;
      const [range, setRange] = useState<EditorVisibleRange | null>(null);
      const [syntax, setSyntax] = useState<{
        documentId: string;
        version: number;
        tokens: EditorToken[];
      } | null>(null);
      useEffect(() => {
        if (
          !enabled ||
          inComposition ||
          !documentId ||
          version === undefined ||
          !range ||
          range.documentId !== documentId ||
          range.version !== version
        )
          return;
        let cancelled = false;
        const timer = setTimeout(() => {
          void action<EditorToken[]>("syntax", { range }).then(
            (tokens) => {
              if (!cancelled) setSyntax({ documentId, version, tokens });
            },
            () => {},
          );
        }, 220);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [documentId, version, enabled, inComposition, range]);
      return {
        tokens: syntax?.tokens ?? [],
        tokensDocumentId: syntax?.documentId ?? null,
        tokensVersion: syntax?.version ?? null,
        onVisibleRangeSettled: setRange,
      };
    },
    document() {
      const entry = store.getState().model.editor.entry;
      return entry?.documentId && entry.version !== undefined
        ? ({
            tabId: entry.tabId,
            documentId: entry.documentId,
            version: entry.version,
            content: entry.content,
            path: entry.path,
            name: entry.name,
            dirty: editorHasPendingChanges(entry),
          } satisfies EditorDocument)
        : null;
    },
    change: (_id, content, after) => addChange(content, after),
    changeSaveEncoding: (_id, next) => {
      send("encoding", { next });
      return true;
    },
    save: () =>
      action<boolean>("save").catch((e) => {
        report(e);
        return false;
      }),
    reopen: (_id, next) =>
      action<boolean>("reopen", { next }).catch((e) => {
        report(e);
        return false;
      }),
    reconnect: (_id, sessionId, accept) => action("reconnect", { sessionId, accept }),
    retryOpen: async () => {
      await action("retryOpen").catch(report);
    },
    setup: () => action<boolean>("setup"),
    format: () => send("format"),
    openPluginAction: async (plugin) => {
      const id = store
        .getState()
        .model.editor.commands.find(
          (c) => c.plugin?.id === plugin.id && c.plugin?.command === plugin.command,
        )?.id;
      return action("plugin", { id });
    },
    confirm: (options) => useDialogs.getState().confirm(options),
    beforeInput: (_id, type, s) => {
      before = s;
      inputType = type;
    },
    beginComposition: (_id, s) => {
      editable();
      compositionBase = store.getState().model.editor.entry?.content;
      compositionSelection = s;
      composing = true;
    },
    endComposition: (_id, s) => {
      composing = false;
      const model = store.getState().model,
        entry = model.editor.entry;
      if (entry && compositionBase !== undefined && compositionBase !== entry.content) {
        edits.push({
          ...editorPatch(compositionBase, entry.content),
          inputType: "insertCompositionText",
          before: compositionSelection,
          after: s,
        });
        store.setState({
          model: {
            ...model,
            editor: { ...model.editor, entry: { ...entry, version: (entry.version ?? 0) + 1 } },
          },
        });
        schedule();
      }
      compositionBase = undefined;
      selection = s;
      record.controller.invalidate();
    },
    rememberSelection: (_id, s) => {
      selection = s;
    },
    suspendSelection: (_id, s) => {
      selection = s;
      record.controller.invalidate();
    },
    restoreSelection: () => selection,
    peekSelection: () => restore,
    consumeSelection: () => {
      const s = restore;
      restore = null;
      return s;
    },
    undo: (_id, redo) => {
      if (composing || failure || busy) return false;
      send("undo", { redo, selection });
      return true;
    },
    clearLocation() {
      const model = store.getState().model,
        target = model.editor.location;
      if (!target) return;
      store.setState({ model: { ...model, editor: { ...model.editor, location: null } } });
      void client
        .action(owned(), {
          kind: "editor",
          command: { operation: "clearLocation", data: { target } },
        })
        .catch(report);
    },
    interaction(value) {
      uiBlocked = value;
    },
    rendered(value) {
      const entry = store.getState().model.editor.entry;
      ready =
        value &&
        (!expected ||
          (entry?.documentId === expected.documentId && (entry.version ?? -1) >= expected.version));
      if (ready) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    },
    resumeFocus(focus) {
      if (wantsFocus && !busy) {
        wantsFocus = false;
        focus();
      }
    },
    attachView(read, focused) {
      readSelection = read;
      readFocused = focused ?? (() => false);
      return () => {
        readSelection = () => selection;
      };
    },
    bindShortcuts: bindShortcutProvider,
    shortcutCandidates: scopedShortcutCandidates,
    ConflictDialog({ onClose }) {
      useEffect(() => {
        void action("review").catch(report).finally(onClose);
      }, [onClose]);
      return null;
    },
  };
  return {
    services,
    update,
    activate: publish,
    mount() {
      disposed = false;
      const unregisterRevision = record.controller.registerAsync("editor.revision", async () => {
        await flush();
        const entry = store.getState().model.editor.entry;
        return entry?.documentId
          ? { documentId: entry.documentId, version: entry.version ?? 0 }
          : null;
      });
      const unregister = record.controller.registerAsync(
        "editor.selection",
        async () => {
          if (uiBlocked || busy) throw new Error("panel.window.moveInProgress");
          await flush();
          if (failure && !recovered) throw new Error(failure);
          return readSelection();
        },
        async (signal) => {
          if (ready) return;
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              signal.removeEventListener("abort", abort);
              waiters.delete(done);
              resolve();
            };
            const abort = () => {
              waiters.delete(done);
              reject(new Error("panel.window.cancelled"));
            };
            signal.addEventListener("abort", abort, { once: true });
            waiters.add(done);
            if (signal.aborted) abort();
          });
        },
      );
      return () => {
        unregister();
        unregisterRevision();
      };
    },
    flush,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      waiters.clear();
    },
  };
}
/** Main keeps its synchronous authoritative edit/history path. Only view state
 * crosses windows; no second filesystem resource or undo stack is created. */
export function useMainEditorWindowServices(
  record: WindowViewRecord,
  tabId: string,
): EditorPageServices {
  const [binding] = useState(() => {
    let ready = false,
      composing = false,
      blocked = false;
    let read = () => mainEditorPageServices.restoreSelection("");
    const expected = record.controller.read(
      "editor.revision",
      (v): v is { documentId: string; version: number } =>
        !!v &&
        typeof (v as { documentId?: unknown }).documentId === "string" &&
        Number.isInteger((v as { version?: unknown }).version),
    );
    const waiters = new Set<() => void>();
    const restored = record.controller.read("editor.selection", isSelection);
    return {
      services: {
        ...mainEditorPageServices,
        restoreSelection: (id: string) => restored ?? mainEditorPageServices.restoreSelection(id),
        interaction(value: boolean) {
          blocked = value;
        },
        rendered(value: boolean) {
          const entry = useEditors.getState().entries[tabId];
          ready =
            value &&
            (!expected ||
              (entry?.documentId === expected.documentId &&
                (entry.version ?? -1) >= expected.version));
          if (ready) {
            for (const done of waiters) done();
            waiters.clear();
          }
        },
        attachView(get: typeof read) {
          read = get;
          return () => {};
        },
        beginComposition: (...args: Parameters<EditorPageServices["beginComposition"]>) => {
          composing = true;
          mainEditorPageServices.beginComposition(...args);
        },
        endComposition: (...args: Parameters<EditorPageServices["endComposition"]>) => {
          composing = false;
          mainEditorPageServices.endComposition(...args);
        },
      },
      mount() {
        const revision = record.controller.registerAsync("editor.revision", async () => {
          const entry = useEditors.getState().entries[tabId];
          return entry?.documentId
            ? { documentId: entry.documentId, version: entry.version ?? 0 }
            : null;
        });
        const unregister = record.controller.registerAsync(
          "editor.selection",
          async () => {
            if (composing || blocked) throw new Error("panel.window.moveInProgress");
            return read();
          },
          async (signal) => {
            if (ready) return;
            await new Promise<void>((resolve, reject) => {
              const done = () => {
                signal.removeEventListener("abort", abort);
                waiters.delete(done);
                resolve();
              };
              const abort = () => {
                waiters.delete(done);
                reject(new Error("panel.window.cancelled"));
              };
              signal.addEventListener("abort", abort, { once: true });
              waiters.add(done);
              if (signal.aborted) abort();
            });
          },
        );
        return () => {
          unregister();
          revision();
        };
      },
    };
  });
  useLayoutEffect(() => binding.mount(), [binding]);
  return binding.services;
}
