import { RefreshCw, Save, ShieldCheck, WandSparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";
import { Dialog } from "@/components/ui/overlay/Dialog";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn } from "@/lib/text/format";
import { editorHasPendingChanges, type EditorSelectionSnapshot } from "@/store/editors";
import type { EditorPageServices } from "./editorPageServices";
import { mainEditorPageServices } from "./mainEditorPageServices";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import type { TextEncoding } from "@/lib/api/types";
import type { EditorView } from "@codemirror/view";
import { editorTextMap, editorToSource, sourceToEditor } from "./editorText";
import { locationOffset } from "./largeEditorState";

const LargeEditor = lazy(() =>
  import("./LargeEditor").then((module) => ({ default: module.LargeEditor })),
);

interface EditorPageProps {
  tabId: string;
  active: boolean;
}

function EncodingPickerDialog({
  open,
  title,
  description,
  closeLabel,
  options,
  current,
  onClose,
  onChoose,
}: {
  open: boolean;
  title: string;
  description: string;
  closeLabel: string;
  options: Array<{ value: TextEncoding; label: string }>;
  current: TextEncoding;
  onClose: () => void;
  onChoose: (encoding: TextEncoding) => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      width={420}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {closeLabel}
        </Button>
      }
    >
      <p className="td-field__hint">{description}</p>
      <div className="encoding-picker" role="list">
        {options.map((option) => (
          <Button
            key={option.value}
            variant={option.value === current ? "secondary" : "ghost"}
            aria-pressed={option.value === current}
            onClick={() => onChoose(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}

export function EditorPage(props: EditorPageProps) {
  return <EditorPageView {...props} services={mainEditorPageServices} />;
}
export function EditorPageView({
  tabId,
  active,
  services,
}: EditorPageProps & { services: EditorPageServices }) {
  const { t } = useTranslation();
  const model = services.useModel(tabId);
  const { entry, candidate, formatting, hasFormatter, location } = model;
  const { wordWrap, tabSize, spellCheck } = model.preferences;
  const { change, changeSaveEncoding, save, reconnect, reopen } = services;
  const ConflictDialog = services.ConflictDialog;
  const [reconnecting, setReconnecting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupFailure, setSetupFailure] = useState<{ scope: string; message: string } | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenPicker, setReopenPicker] = useState(false);
  const dirty = !!entry && !entry.loading && editorHasPendingChanges(entry);
  const encodingOptions: Array<{ value: TextEncoding; label: string }> = [
    { value: "utf-8", label: "UTF-8" },
    { value: "utf-16le", label: "UTF-16 LE" },
    { value: "utf-16be", label: "UTF-16 BE" },
    { value: "gb18030", label: "GB18030" },
    { value: "gbk", label: "GBK" },
    { value: "big5", label: "Big5" },
    { value: "shift-jis", label: "Shift-JIS" },
    { value: "euc-jp", label: "EUC-JP" },
    { value: "euc-kr", label: "EUC-KR" },
    { value: "windows-1252", label: "Windows-1252" },
  ];
  const [enabledScope, setEnabledScope] = useState<string | null>(null);
  const largeView = useRef<EditorView | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const [fallbackDocumentId] = useState(() => entry?.documentId ?? crypto.randomUUID());
  const documentId = entry?.documentId ?? fallbackDocumentId;
  const documentVersion = entry?.version ?? 0;
  const syntaxDocument =
    entry && !entry.loading && !entry.error && !entry.disconnected
      ? {
          tabId,
          documentId,
          version: documentVersion,
          path: entry.path,
          name: entry.name,
          content: entry.content,
          dirty: editorHasPendingChanges(entry),
        }
      : null;
  const composing = useRef(false);
  const [syntaxComposing, setSyntaxComposing] = useState(false);
  const syntax = services.useSyntax(
    syntaxDocument,
    active && !!syntaxDocument && !model.frozen,
    syntaxComposing,
  );
  const lastEditorContent = useRef(entry?.content ?? "");
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [largeRestore, setLargeRestore] = useState<{
    token: number;
    selection: EditorSelectionSnapshot;
  } | null>(null);
  useEffect(() => {
    if (entry && !entry.loading && !entry.error && entry.documentId === undefined)
      services.document(tabId);
    // The upgrade runs once per stable document state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.documentId, entry?.error, entry?.loading, tabId]);
  useBackgroundGuard(
    reconnecting || formatting || reviewing || settingUp || reopening || reopenPicker,
  );
  useLayoutEffect(() => {
    services.interaction?.(
      reconnecting || formatting || reviewing || settingUp || reopening || reopenPicker,
    );
  }, [services, reconnecting, formatting, reviewing, settingUp, reopening, reopenPicker]);
  const setup = async () => {
    if (!entry?.sessionId || settingUp) return;
    const session = entry.sessionId;
    const path = entry.path;
    setSetupFailure(null);
    setSettingUp(true);
    try {
      if (await services.setup(session, path)) {
        setEnabledScope(`${session}:${path}`);
        toast(t("editor.nativeSetupComplete"), "success");
      }
    } catch (error) {
      const message = translateError(error);
      setSetupFailure({ scope: `${session}:${path}`, message });
      toast(message, "error");
    } finally {
      setSettingUp(false);
    }
  };
  useEffect(() => {
    const instance = largeView.current;
    if (!instance || composing.current || !entry?.documentId || entry.version === undefined) return;
    const restored = services.consumeSelection(
      tabId,
      entry.documentId,
      entry.version,
      entry.content,
    );
    if (restored)
      queueMicrotask(() =>
        setLargeRestore((current) => ({ token: (current?.token ?? 0) + 1, selection: restored })),
      );
  }, [entry, selectionRevision, tabId, services]);

  useEffect(() => {
    if (entry?.content !== undefined) lastEditorContent.current = entry.content;
  }, [entry?.content, entry?.documentId, entry?.version]);

  useEffect(() => {
    if (!largeRestore) return;
    const timer = setTimeout(() => setLargeRestore(null), 0);
    return () => clearTimeout(timer);
  }, [largeRestore]);

  const currentSourceSelection = (): EditorSelectionSnapshot | null => {
    const view = largeView.current;
    if (!view) return null;
    const range = view.state.selection.main;
    const map = editorTextMap(lastEditorContent.current);
    return {
      start: editorToSource(map, range.from),
      end: editorToSource(map, range.to),
      direction: range.anchor <= range.head ? "forward" : "backward",
      scrollTop: view.scrollDOM.scrollTop,
      scrollLeft: view.scrollDOM.scrollLeft,
    };
  };
  useEffect(() => {
    void (async () => {
      const instance = largeView.current;
      if (
        !active ||
        location?.tabId !== tabId ||
        !entry ||
        entry.loading ||
        entry.error ||
        !instance
      )
        return;
      const line = Math.max(1, Math.min(instance.state.doc.lines, location.line));
      const target = instance.state.doc.line(line);
      const offset = sourceToEditor(
        editorTextMap(entry.content),
        locationOffset(entry.content, location.line, location.column),
      );
      const clamped = Math.max(target.from, Math.min(target.to, offset));
      instance.dispatch({
        selection: { anchor: clamped },
        effects: [
          (await import("@codemirror/view")).EditorView.scrollIntoView(clamped, { y: "center" }),
        ],
      });
      instance.focus();
      services.clearLocation();
    })();
  }, [active, location, tabId, entry, services]);

  const reopenWithEncoding = async (encoding: TextEncoding) => {
    if (!entry || reopening || dirty || entry.loading || entry.saving || entry.disconnected) return;
    setReopening(true);
    try {
      await reopen(tabId, encoding);
    } finally {
      setReopening(false);
    }
  };
  const changeEncoding = (encoding: TextEncoding) => {
    if (!entry || reopening || entry.saving) return;
    if (entry.decodeError) void reopenWithEncoding(encoding);
    else changeSaveEncoding(tabId, encoding);
  };

  const recover = async () => {
    if (!candidate || reconnecting) return;
    setReconnecting(true);
    try {
      const target = { hostId: candidate.hostId, address: candidate.address };
      const result = await reconnect(tabId, candidate.id, false, target);
      if (result === "conflict")
        services.confirm({
          title: t("editor.conflictTitle"),
          body: t("editor.conflictBody"),
          confirmLabel: t("editor.reconnect"),
          onConfirm: async () => {
            await reconnect(tabId, candidate.id, true, target);
          },
        });
    } finally {
      setReconnecting(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    const element = page.current;
    if (!element) return;
    return services.bindShortcuts(element, (event) => {
      const commands =
        !entry || entry.loading || entry.error || entry.disconnected ? [] : model.commands;
      const document = services.document(tabId);
      let queue = Promise.resolve();
      return services.shortcutCandidates(
        event,
        commands.map((command) => command.id),
        (id) => {
          if (id === "editor.save" && settingUp) return true;
          if (id === "editor.save")
            queue = queue.then(async () => {
              await save(tabId);
            });
          else if (id === "editor.undo" || id === "editor.redo") {
            const selection = currentSourceSelection();
            if (selection) services.rememberSelection(tabId, selection);
            return services.undo(tabId, id === "editor.redo");
          } else {
            const action = commands.find((command) => command.id === id)?.plugin;
            if (!action) return false;
            queue = queue.then(async () => {
              await services.openPluginAction(action, document);
            });
          }
          return true;
        },
      );
    });
  }, [active, save, tabId, entry, settingUp, services, model.commands]);

  const [viewReady, setViewReady] = useState(false);
  useLayoutEffect(() => {
    services.rendered?.(!!entry && !entry.loading && (viewReady || !!entry.error));
  }, [entry, services, viewReady]);
  useLayoutEffect(
    () => services.attachView?.(currentSourceSelection, () => largeView.current?.hasFocus ?? false),
    [services],
  );
  useLayoutEffect(() => {
    if (!model.frozen)
      services.resumeFocus?.(() => {
        if (document.hasFocus()) largeView.current?.focus();
      });
  }, [model.frozen, services]);
  if (!entry) {
    return (
      <div className="page">
        <EmptyState title={t("editor.loading")} />
      </div>
    );
  }

  return (
    <div className="editor-page" ref={page}>
      <header className="editor-head">
        <span className={cn("editor-dot", dirty && "is-dirty")} aria-hidden="true" />
        <span className="editor-head__name">{entry.name}</span>
        <span className="editor-head__path" title={entry.path}>
          {entry.path}
        </span>
        <Select
          className="editor-head__encoding"
          value={entry.encoding ?? "utf-8"}
          label={t(entry.decodeError ? "editor.reopenEncodingTitle" : "editor.saveEncoding")}
          disabled={
            reopening ||
            entry.loading ||
            (!!entry.error && !entry.decodeError) ||
            entry.disconnected ||
            entry.saving
          }
          options={encodingOptions}
          onChange={(value) => changeEncoding(value as TextEncoding)}
          footerAction={
            !dirty
              ? {
                  label: t("editor.reopenEncoding"),
                  onSelect: () => setReopenPicker(true),
                }
              : undefined
          }
        />
        {entry.sessionId ? (
          <Button
            variant="ghost"
            size="sm"
            leading={<ShieldCheck size={13} />}
            title={t("editor.nativeSetupDescription")}
            disabled={
              settingUp ||
              entry.loading ||
              !!entry.error ||
              entry.disconnected ||
              entry.saving ||
              enabledScope === `${entry.sessionId}:${entry.path}`
            }
            onClick={() => void setup()}
          >
            {t(
              settingUp
                ? "editor.nativeSettingUp"
                : enabledScope === `${entry.sessionId}:${entry.path}`
                  ? "editor.nativeSetupEnabled"
                  : "editor.nativeEnableSetup",
            )}
          </Button>
        ) : null}
        {hasFormatter || formatting ? (
          <Button
            variant="ghost"
            size="sm"
            leading={<WandSparkles size={13} />}
            aria-label={t(formatting ? "editor.formatting" : "editor.format")}
            title={t(formatting ? "editor.formatting" : "editor.format")}
            disabled={formatting || entry.loading || !!entry.error || entry.disconnected}
            onClick={() => services.format(tabId)}
          >
            {t(formatting ? "editor.formatting" : "editor.format")}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          leading={<Save size={13} />}
          aria-label={t(entry.saving ? "editor.saving" : "editor.save")}
          title={t(entry.saving ? "editor.saving" : "editor.save")}
          disabled={!dirty || entry.saving || entry.loading || entry.disconnected || settingUp}
          onClick={() => void save(tabId)}
        >
          {t(entry.saving ? "editor.saving" : "editor.save")}
        </Button>
      </header>

      <EncodingPickerDialog
        open={reopenPicker}
        title={t("editor.reopenEncodingTitle")}
        description={t("editor.reopenEncodingDescription")}
        closeLabel={t("common.close")}
        options={encodingOptions}
        current={entry.encoding ?? "utf-8"}
        onClose={() => setReopenPicker(false)}
        onChoose={(encoding) => {
          setReopenPicker(false);
          void reopenWithEncoding(encoding);
        }}
      />

      {model.syncFailure ? (
        <div className="editor-offline" role="alert">
          {model.syncFailure}
        </div>
      ) : null}
      {setupFailure?.scope === `${entry.sessionId}:${entry.path}` ? (
        <div className="editor-offline" role="alert">
          <span>{setupFailure.message}</span>
        </div>
      ) : null}
      {entry.recovered ? (
        <div className="editor-offline" role="status">
          <span>{t("editor.recoveredDraft")}</span>
        </div>
      ) : null}
      {entry.saveFailure ? (
        <div className="editor-offline" role="alert">
          <span>{entry.saveFailure}</span>
          {entry.saveConflict && !entry.disconnected ? (
            <Button size="sm" onClick={() => setReviewing(true)}>
              {t("editor.reviewChanges")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {reviewing ? <ConflictDialog tabId={tabId} onClose={() => setReviewing(false)} /> : null}

      {entry.disconnected ? (
        <div className="editor-offline" role="status">
          <span>{t("editor.offline")}</span>
          {candidate ? (
            <Button size="sm" disabled={reconnecting} onClick={() => void recover()}>
              {t("editor.reconnect")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {entry.error ? (
        <div className="page">
          <EmptyState
            title={entry.error}
            action={
              entry.baselineLoaded === false &&
              !entry.disconnected &&
              !dirty &&
              !entry.loading &&
              !entry.saving ? (
                <Button
                  size="sm"
                  leading={<RefreshCw size={13} />}
                  onClick={() => void services.retryOpen(tabId)}
                >
                  {t("common.retry")}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : entry.loading ? (
        <div className="page">
          <EmptyState title={t("editor.loading")} />
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="page">
              <EmptyState title={t("editor.loading")} />
            </div>
          }
        >
          <LargeEditor
            content={entry.content}
            documentId={documentId}
            version={documentVersion}
            label={entry.name}
            readOnly={entry.disconnected || model.frozen}
            wordWrap={wordWrap}
            tabSize={tabSize}
            spellCheck={spellCheck}
            tokens={syntax.tokens}
            tokensDocumentId={syntax.tokensDocumentId ?? undefined}
            tokensVersion={syntax.tokensVersion ?? undefined}
            onVisibleRangeSettled={syntax.onVisibleRangeSettled}
            viewRef={largeView}
            onViewReady={() => {
              setViewReady(true);
              const pending = services.peekSelection(
                tabId,
                documentId,
                documentVersion,
                entry.content,
              );
              const restored = pending ?? services.restoreSelection(tabId);
              if (restored)
                setLargeRestore((current) => ({
                  token: (current?.token ?? 0) + 1,
                  selection: restored,
                }));
            }}
            restoreSelection={largeRestore?.selection}
            restoreToken={largeRestore?.token}
            onBeforeInput={(inputType, selection) =>
              services.beforeInput(tabId, inputType, selection)
            }
            onChange={(content, selection) => {
              lastEditorContent.current = content;
              change(tabId, content, selection);
              services.rememberSelection(tabId, selection);
            }}
            onSelection={(selection) => {
              services.rememberSelection(tabId, selection);
              services.suspendSelection(tabId, selection);
            }}
            onSelectionSnapshot={(selection) => {
              services.rememberSelection(tabId, selection);
              services.suspendSelection(tabId, selection);
            }}
            onSelectionChanged={(selection) => services.suspendSelection(tabId, selection)}
            onCompositionStart={(selection) => {
              composing.current = true;
              setSyntaxComposing(true);
              services.beginComposition(tabId, selection);
            }}
            onCompositionEnd={(selection) => {
              composing.current = false;
              setSyntaxComposing(false);
              services.endComposition(tabId, selection);
              setSelectionRevision((revision) => revision + 1);
            }}
            onUndo={() => {
              const selection = currentSourceSelection();
              if (selection) services.rememberSelection(tabId, selection);
              return services.undo(tabId);
            }}
            onRedo={() => {
              const selection = currentSourceSelection();
              if (selection) services.rememberSelection(tabId, selection);
              return services.undo(tabId, true);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
