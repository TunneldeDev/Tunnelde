import { Save, WandSparkles } from "lucide-react";
import { matchesCommand, shortcutCommands } from "@/lib/keyboard/registry";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn } from "@/lib/text/format";
import { useEditors, undoEditorEdit } from "@/store/editors";
import { usePlugins } from "@/store/plugins";
import {
  editorCommandMatches,
  formatEditorDocument,
  useFormatting,
} from "@/lib/plugins/formatting";
import { openPluginAction } from "@/lib/plugins/actions";
import { runWorkbenchCommand } from "@/lib/keyboard/actions";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useEditorLocation } from "@/store/editorLocation";
import { useViewElementState, useBackgroundGuard } from "@/lib/session/viewState";
import { EditorConflictDialog } from "./EditorConflictDialog";

interface EditorPageProps {
  tabId: string;
  active: boolean;
}

export function EditorPage({ tabId, active }: EditorPageProps) {
  const { t } = useTranslation();
  const entry = useEditors((state) => state.entries[tabId]);
  const change = useEditors((state) => state.change);
  const save = useEditors((state) => state.save);
  const reconnect = useEditors((state) => state.reconnect);
  const wordWrap = useSettings((state) => state.settings.editorWordWrap);
  const tabSize = useSettings((state) => state.settings.editorTabSize);
  const spellCheck = useSettings((state) => state.settings.editorSpellCheck);
  const hostId = useWorkspace((state) => state.tabs.find((tab) => tab.id === tabId)?.hostId);
  const candidate = useSsh((state) =>
    state.sessions.find((session) => session.hostId === hostId && session.purpose !== "forwarding"),
  );
  const [reconnecting, setReconnecting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const formatting = useFormatting((state) => state.busy.includes(tabId));
  const textarea = useRef<HTMLTextAreaElement>(null);
  useViewElementState(`editor:${tabId}:selection`, textarea, !!entry && !entry.loading);
  useBackgroundGuard(reconnecting || formatting || reviewing);
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

  const recover = async () => {
    if (!candidate || reconnecting) return;
    setReconnecting(true);
    try {
      const result = await reconnect(tabId, candidate.id);
      if (result === "conflict")
        useDialogs.getState().confirm({
          title: t("editor.conflictTitle"),
          body: t("editor.conflictBody"),
          confirmLabel: t("common.apply"),
          danger: true,
          onConfirm: async () => {
            await reconnect(tabId, candidate.id, true);
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (
        !(event.target instanceof Element) ||
        event.target.closest(".editor-page") !== textarea.current?.closest(".editor-page")
      )
        return;
      const definitions = shortcutCommands(usePlugins.getState().items);
      const plugins = usePlugins.getState().items;
      const overrides = useSettings.getState().settings.keyboardShortcuts;
      const editorCommands = definitions.filter((item) => {
        if (item.scope !== "editor" || !matchesCommand(event, item.id, overrides, definitions))
          return false;
        if (!item.plugin?.command) return true;
        const contributed = plugins
          .find((plugin) => plugin.id === item.plugin?.id)
          ?.commands.find((command) => command.id === item.plugin?.command);
        return (
          !!entry &&
          !!contributed?.editor &&
          editorCommandMatches(entry.path, contributed.editor.extensions)
        );
      });
      if (!editorCommands.length) return;
      // Workbench shortcuts also apply in the editor when explicitly shared with a plugin.
      const workbenchCommands = definitions.filter(
        (item) =>
          item.scope === "workbench" &&
          item.input &&
          matchesCommand(event, item.id, overrides, definitions),
      );
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        for (const command of editorCommands) {
          if (command.id === "editor.save") await save(tabId);
          else if (command.id === "editor.undo" || command.id === "editor.redo")
            undoEditorEdit(tabId, command.id === "editor.redo");
          else if (command.plugin) await openPluginAction(command.plugin);
          else runWorkbenchCommand(command.id);
        }
        for (const command of workbenchCommands) runWorkbenchCommand(command.id);
      })();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, save, tabId, entry]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        undoEditorEdit(tabId, event.inputType === "historyRedo");
      }
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

  const dirty = !entry.loading && entry.content !== entry.baseline;

  return (
    <div className="editor-page">
      <header className="editor-head">
        <span className={cn("editor-dot", dirty && "is-dirty")} aria-hidden="true" />
        <span className="editor-head__name">{entry.name}</span>
        <span className="editor-head__path" title={entry.path}>
          {entry.path}
        </span>
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
        <Button
          variant="secondary"
          size="sm"
          leading={<Save size={13} />}
          aria-label={t(entry.saving ? "editor.saving" : "editor.save")}
          title={t(entry.saving ? "editor.saving" : "editor.save")}
          disabled={!dirty || entry.saving || entry.loading || entry.disconnected}
          onClick={() => void save(tabId)}
        >
          {t(entry.saving ? "editor.saving" : "editor.save")}
        </Button>
      </header>

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
        <textarea
          ref={textarea}
          className="editor-body"
          aria-label={entry.name}
          spellCheck={spellCheck}
          wrap={wordWrap ? "soft" : "off"}
          style={{
            whiteSpace: wordWrap ? "pre-wrap" : "pre",
            overflowWrap: wordWrap ? "anywhere" : "normal",
            tabSize,
          }}
          value={entry.content}
          onChange={(event) => change(tabId, event.target.value)}
        />
      )}
    </div>
  );
}
