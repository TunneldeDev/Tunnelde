import { Save, ShieldCheck, WandSparkles } from "lucide-react";
import { shortcutCommands } from "@/lib/keyboard/registry";
import { bindShortcutProvider, scopedShortcutCandidates } from "@/lib/keyboard/routing";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/form/Select";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn } from "@/lib/text/format";
import {
  beginEditorComposition,
  beginEditorInput,
  consumeEditorSelectionRestore,
  endEditorComposition,
  editorDocument,
  editorHasPendingChanges,
  rememberEditorSelection,
  undoEditorEdit,
  useEditors,
  type EditorSelectionSnapshot,
} from "@/store/editors";
import { usePlugins } from "@/store/plugins";
import {
  documentFormatters,
  editorCommandMatches,
  formatEditorDocument,
  useFormatting,
} from "@/lib/plugins/formatting";
import { openPluginAction } from "@/lib/plugins/actions";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useEditorLocation } from "@/store/editorLocation";
import { useViewElementState, useBackgroundGuard } from "@/lib/session/viewState";
import { EditorConflictDialog } from "./EditorConflictDialog";
import { EditorSyntaxOverlay } from "./syntax/EditorSyntaxOverlay";
import { useEditorSyntax } from "./syntax/useEditorSyntax";
import { useEditorSyntaxMetrics } from "./syntax/useEditorSyntaxMetrics";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import type { TextEncoding } from "@/lib/api/types";

interface EditorPageProps {
  tabId: string;
  active: boolean;
}

function selectionSnapshot(element: HTMLTextAreaElement): EditorSelectionSnapshot {
  return {
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection,
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
  };
}

export function EditorPage({ tabId, active }: EditorPageProps) {
  const { t } = useTranslation();
  const entry = useEditors((state) => state.entries[tabId]);
  const change = useEditors((state) => state.change);
  const save = useEditors((state) => state.save);
  const reconnect = useEditors((state) => state.reconnect);
  const reopen = useEditors((state) => state.reopen);
  const wordWrap = useSettings((state) => state.settings.editorWordWrap);
  const tabSize = useSettings((state) => state.settings.editorTabSize);
  const spellCheck = useSettings((state) => state.settings.editorSpellCheck);
  const tabHostId = useWorkspace((state) => state.tabs.find((tab) => tab.id === tabId)?.hostId);
  const hostId = tabHostId ?? entry?.recoveryTarget?.hostId;
  const candidate = useSsh((state) =>
    state.sessions.find(
      (session) =>
        session.hostId === hostId &&
        session.purpose !== "forwarding" &&
        (!entry?.recoveryTarget || session.address === entry.recoveryTarget.address),
    ),
  );
  const [reconnecting, setReconnecting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupFailure, setSetupFailure] = useState<{ scope: string; message: string } | null>(null);
  const [reopening, setReopening] = useState(false);
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
  const formatting = useFormatting((state) => state.busy.includes(tabId));
  const hasFormatter = usePlugins(
    (state) => !!entry && documentFormatters(entry.path, state.items).length > 0,
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [syntaxComposing, setSyntaxComposing] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  useViewElementState(`editor:${tabId}:selection`, textarea, !!entry && !entry.loading);
  useBackgroundGuard(reconnecting || formatting || reviewing || settingUp || reopening);
  const syntaxDocument =
    entry && !entry.loading && !entry.error && !entry.disconnected ? editorDocument(tabId) : null;
  const syntax = useEditorSyntax({
    document: syntaxDocument,
    composing: syntaxComposing,
    enabled: !!entry && !entry.loading && !entry.error && !entry.disconnected,
  });
  const syntaxMetrics = useEditorSyntaxMetrics(textarea, syntax.highlighted, [
    entry?.content,
    entry?.path,
    wordWrap,
    tabSize,
    syntax.highlighted,
  ]);
  const setup = async () => {
    if (!entry?.sessionId || settingUp) return;
    const session = entry.sessionId;
    const path = entry.path;
    setSetupFailure(null);
    setSettingUp(true);
    try {
      if (await api.sftpSetupNativeSave(session, path)) {
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
  useLayoutEffect(() => {
    const element = textarea.current;
    if (
      composing.current ||
      !element ||
      !entry ||
      entry.loading ||
      entry.error ||
      !entry.documentId ||
      entry.version === undefined
    )
      return;
    const restored = consumeEditorSelectionRestore(
      tabId,
      entry.documentId,
      entry.version,
      entry.content,
    );
    if (!restored) return;
    element.setSelectionRange(restored.start, restored.end, restored.direction);
    if (restored.scrollTop !== undefined) element.scrollTop = restored.scrollTop;
    if (restored.scrollLeft !== undefined) element.scrollLeft = restored.scrollLeft;
  }, [entry, selectionRevision, tabId]);

  const location = useEditorLocation((state) => state.target);
  useEffect(() => {
    if (
      !active ||
      location?.tabId !== tabId ||
      !entry ||
      entry.loading ||
      entry.error ||
      !textarea.current
    )
      return;
    const lines = entry.content.split("\n");
    const line = Math.max(0, Math.min(lines.length - 1, location.line - 1));
    const offset =
      lines.slice(0, line).reduce((total, item) => total + item.length + 1, 0) +
      Array.from(lines[line] ?? "")
        .slice(0, Math.max(0, location.column - 1))
        .join("").length;
    const element = textarea.current;
    element.focus();
    element.setSelectionRange(offset, offset);
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 20;
    element.scrollTop = Math.max(0, line * lineHeight - element.clientHeight / 3);
    useEditorLocation.getState().clear();
  }, [active, location, tabId, entry]);

  const changeEncoding = async (encoding: TextEncoding) => {
    if (!entry || reopening || dirty) return;
    setReopening(true);
    try {
      await reopen(tabId, encoding);
    } finally {
      setReopening(false);
    }
  };

  const recover = async () => {
    if (!candidate || reconnecting) return;
    setReconnecting(true);
    try {
      const target = { hostId: candidate.hostId, address: candidate.address };
      const result = await reconnect(tabId, candidate.id, false, target);
      if (result === "conflict")
        useDialogs.getState().confirm({
          title: t("editor.conflictTitle"),
          body: t("editor.conflictBody"),
          confirmLabel: t("common.apply"),
          danger: true,
          onConfirm: async () => {
            await reconnect(tabId, candidate.id, true, target);
          },
        });
    } finally {
      setReconnecting(false);
    }
  };

  useEffect(() => {
    if (!active) {
      return;
    }
    const element = textarea.current?.closest<HTMLElement>(".editor-page");
    if (!element) return;
    return bindShortcutProvider(element, (event) => {
      const plugins = usePlugins.getState().items;
      const commands = shortcutCommands(plugins).filter((item) => {
        if (item.scope !== "editor" || !entry || entry.loading || entry.error || entry.disconnected)
          return false;
        if (!item.plugin?.command) return true;
        const contributed = plugins
          .find((plugin) => plugin.id === item.plugin?.id)
          ?.commands.find((command) => command.id === item.plugin?.command);
        return (
          !!contributed?.editor && editorCommandMatches(entry.path, contributed.editor.extensions)
        );
      });
      const document = editorDocument(tabId);
      let queue = Promise.resolve();
      return scopedShortcutCandidates(
        event,
        commands.map((command) => command.id),
        (id) => {
          if (id === "editor.save" && settingUp) return true;
          if (id === "editor.save")
            queue = queue.then(async () => {
              await save(tabId);
            });
          else if (id === "editor.undo" || id === "editor.redo") {
            if (textarea.current)
              rememberEditorSelection(tabId, selectionSnapshot(textarea.current));
            return undoEditorEdit(tabId, id === "editor.redo");
          } else {
            const action = commands.find((command) => command.id === id)?.plugin;
            if (!action) return false;
            queue = queue.then(async () => {
              await openPluginAction(action, document);
            });
          }
          return true;
        },
      );
    });
  }, [active, save, tabId, entry, settingUp]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (composing.current) return;
      const selection = selectionSnapshot(element);
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        rememberEditorSelection(tabId, selection);
        undoEditorEdit(tabId, event.inputType === "historyRedo");
        return;
      }
      if (event.inputType === "insertCompositionText") {
        composing.current = true;
        setSyntaxComposing(true);
        beginEditorComposition(tabId, selection);
        return;
      }
      beginEditorInput(tabId, event.inputType, selection);
    };
    element.addEventListener("beforeinput", beforeInput);
    return () => element.removeEventListener("beforeinput", beforeInput);
  }, [tabId, entry?.loading, entry?.error]);

  if (!entry) {
    return (
      <div className="page">
        <EmptyState title={t("editor.loading")} />
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="editor-head">
        <span className={cn("editor-dot", dirty && "is-dirty")} aria-hidden="true" />
        <span className="editor-head__name">{entry.name}</span>
        <span className="editor-head__path" title={entry.path}>
          {entry.path}
        </span>
        <Select
          className="editor-head__encoding"
          value={entry.encoding ?? "utf-8"}
          label={t("editor.encoding")}
          disabled={
            reopening ||
            entry.loading ||
            (!!entry.error && !entry.decodeError) ||
            entry.disconnected ||
            entry.saving ||
            dirty
          }
          options={encodingOptions}
          onChange={(value) => void changeEncoding(value as TextEncoding)}
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
            onClick={() => formatEditorDocument(tabId)}
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
      {reviewing ? (
        <EditorConflictDialog tabId={tabId} onClose={() => setReviewing(false)} />
      ) : null}

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
          <EmptyState title={entry.error} />
        </div>
      ) : entry.loading ? (
        <div className="page">
          <EmptyState title={t("editor.loading")} />
        </div>
      ) : (
        <div
          className="td-syntax-editor"
          data-highlighted={syntax.highlighted ? "true" : "false"}
          data-composing={syntaxComposing ? "true" : "false"}
        >
          <EditorSyntaxOverlay
            content={entry.content}
            tokens={syntax.tokens}
            metrics={syntaxMetrics.metrics}
            visible={syntax.highlighted}
          />
          <textarea
            ref={textarea}
            className="editor-body td-code-editor"
            aria-label={entry.name}
            spellCheck={spellCheck}
            wrap={wordWrap ? "soft" : "off"}
            style={{
              whiteSpace: wordWrap ? "pre-wrap" : "pre",
              overflowWrap: wordWrap ? "anywhere" : "normal",
              tabSize,
            }}
            value={entry.content}
            onChange={(event) => change(tabId, event.target.value, selectionSnapshot(event.target))}
            onSelect={(event) =>
              rememberEditorSelection(tabId, selectionSnapshot(event.currentTarget))
            }
            onScroll={(event) => {
              rememberEditorSelection(tabId, selectionSnapshot(event.currentTarget));
              syntaxMetrics.sync();
            }}
            onCompositionStart={(event) => {
              composing.current = true;
              setSyntaxComposing(true);
              beginEditorComposition(tabId, selectionSnapshot(event.currentTarget));
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              endEditorComposition(tabId, selectionSnapshot(event.currentTarget));
              setSelectionRevision((revision) => revision + 1);
              setSyntaxComposing(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
