import { Save } from "lucide-react";
import { matchesCommand } from "@/lib/keyboard/registry";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn } from "@/lib/text/format";
import { useEditors } from "@/store/editors";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useEditorLocation } from "@/store/editorLocation";

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
  const candidate = useSsh((state) => state.sessions.find((session) => session.hostId === hostId));
  const [reconnecting, setReconnecting] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
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
      if (event.target instanceof Element && !event.target.closest(".editor-page")) return;
      if (matchesCommand(event, "editor.save", useSettings.getState().settings.keyboardShortcuts)) {
        event.preventDefault();
        void save(tabId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, save, tabId]);

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
          variant="secondary"
          size="sm"
          leading={<Save size={13} />}
          disabled={!dirty || entry.saving || entry.loading || entry.disconnected}
          onClick={() => void save(tabId)}
        >
          {t(entry.saving ? "editor.saving" : "editor.save")}
        </Button>
      </header>

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
