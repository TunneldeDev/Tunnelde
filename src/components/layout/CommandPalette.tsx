import { FolderOpen, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { runWorkbenchCommand } from "@/lib/keyboard/actions";
import { shortcutCommands, bindingsFor, displayShortcut } from "@/lib/keyboard/registry";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { cn } from "@/lib/text/format";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useQuickAccess } from "@/store/quickAccess";
import { useSearchRoots, type SearchRoot } from "@/store/searchRoots";
import { useEditors, fileName } from "@/store/editors";
import { useEditorLocation } from "@/store/editorLocation";
import { useSsh } from "@/store/ssh";
import { useFilePreview } from "@/store/filePreview";
import { toast } from "@/store/toasts";
import { IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import "@/styles/shortcuts.css";

interface Command {
  id: string;
  title: string;
  detail?: string;
  fileName?: string;
  run: () => void;
}
type Match = Awaited<ReturnType<typeof api.filesSearch>>["matches"][number];

export function CommandPalette() {
  const query = useQuickAccess((state) => state.query);
  return query === null ? null : <QuickAccess initialQuery={query} key={query} />;
}

function QuickAccess({ initialQuery }: { initialQuery: string }) {
  const resolveFileIcon = useFileIconResolver();
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const plugins = usePlugins((state) => state.items);
  const settings = useSettings((state) => state.settings);
  const tabs = useWorkspace((state) => state.tabs);
  const activeTabId = useWorkspace((state) => state.activeId);
  const published = useSearchRoots((state) => state.roots);
  const entries = useEditors((state) => state.entries);
  const sessions = useSsh((state) => state.sessions);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [rootId, setRootId] = useState("");
  const [picked, setPicked] = useState<SearchRoot | null>(null);
  const [result, setResult] = useState<{
    key: string;
    matches: Match[];
    limited: boolean;
    skipped: number;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  const id = useId();
  const close = useQuickAccess((state) => state.close);
  const mode = query.startsWith(">")
    ? "commands"
    : query.startsWith("%")
      ? "content"
      : query.startsWith("@")
        ? "hosts"
        : "files";
  const needle = (mode === "files" ? query : query.slice(1)).trim();
  const definitions = useMemo(() => shortcutCommands(plugins), [plugins]);
  const roots = useMemo(() => {
    const candidates = [
      ...Object.values(published).flat(),
      ...Object.values(entries).map((entry) => ({
        id: `editor:${entry.tabId}`,
        tabId: entry.tabId,
        sessionId: entry.sessionId,
        path: entry.path.slice(0, entry.path.lastIndexOf("/")) || "/",
      })),
      ...(picked ? [picked] : []),
    ];
    candidates.sort((a, b) => Number(b.tabId === activeTabId) - Number(a.tabId === activeTabId));
    const seen = new Set<string>();
    return candidates.filter((root) => {
      const key = `${root.sessionId ?? "local"}\0${root.path}`;
      if (
        seen.has(key) ||
        (root.sessionId && !sessions.some((session) => session.id === root.sessionId))
      )
        return false;
      seen.add(key);
      return true;
    });
  }, [published, entries, picked, activeTabId, sessions]);
  const root = rootId ? roots.find((item) => item.id === rootId) : roots[0];
  const path = root?.path;
  const sessionId = root?.sessionId ?? null;
  const searchKey = `${mode}\0${sessionId}\0${path}\0${needle}`;

  useEffect(() => {
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);
  useEffect(() => {
    if (!["files", "content"].includes(mode) || !path || Array.from(needle).length < 2) return;
    let disposed = false;
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setError("");
      void api
        .filesSearch(requestId, sessionId, path, needle, mode === "content")
        .then((response) => {
          if (!disposed) {
            setResult({ ...response, key: searchKey });
            setIndex(0);
          }
        })
        .catch((cause) => {
          if (!disposed) setError(translateError(cause));
        })
        .finally(() => {
          if (!disposed) setSearching(false);
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void api.filesSearchCancel(requestId).catch(() => {});
    };
  }, [mode, needle, path, sessionId, searchKey]);

  const commands = useMemo<Command[]>(() => {
    if (mode === "commands")
      return definitions
        .filter(
          (item) =>
            (item.scope === "workbench" ||
              (item.scope === "editor" && !!entries[activeTabId ?? ""])) &&
            item.id !== "palette.open",
        )
        .map((item) => ({
          id: item.id,
          title:
            item.title ??
            (item.id === "panel.toggle"
              ? t(settings.rightPanel ? "panel.hide" : "panel.show")
              : item.id === "theme.cycle"
                ? `${t("settings.theme")}: ${t(settings.theme === "dark" ? "settings.themeDark" : settings.theme === "light" ? "settings.themeLight" : "settings.themeSystem")}`
                : t(item.label as ParseKeys, { number: item.id.slice(-1) })),
          run: () => {
            runWorkbenchCommand(item.id);
          },
        }));
    if (mode === "hosts")
      return hosts.flatMap((host) => [
        {
          id: `host.connect.${host.id}`,
          title: `${t("terminal.connect")} · ${host.name}`,
          detail: `${host.username}@${host.host}`,
          run: () => useDialogs.getState().openConnect(host),
        },
        {
          id: `host.open.${host.id}`,
          title: `${t("host.open")} · ${host.name}`,
          run: () => useWorkspace.getState().openHost(host),
        },
      ]);
    const list: Command[] =
      mode === "files"
        ? tabs
            .filter((tab) => !tab.hidden)
            .map((tab) => ({
              id: `tab:${tab.id}`,
              title: tab.title,
              fileName: tab.kind === "editor" ? tab.title : undefined,
              detail: t("palette.openTab"),
              run: () => useWorkspace.getState().activate(tab.id),
            }))
        : [];
    const visible = result?.key === searchKey ? result.matches : [];
    const inRoot = (file: string) =>
      path && (file === path || file.startsWith(`${path.replace(/\/$/, "")}/`));
    const drafts =
      mode === "content" && needle.length >= 2
        ? Object.values(entries).filter(
            (entry) =>
              entry.sessionId === sessionId && inRoot(entry.path) && !entry.loading && !entry.error,
          )
        : [];
    const matches = [
      ...visible.filter((match) => !drafts.some((entry) => entry.path === match.path)),
    ];
    const loweredNeedle = needle.toLocaleLowerCase();
    draftMatches: for (const entry of drafts) {
      for (const [line, text] of entry.content.split("\n").entries()) {
        if (matches.length >= 100) break draftMatches;
        const offset = text.toLocaleLowerCase().indexOf(loweredNeedle);
        if (offset >= 0 && matches.length < 100)
          matches.push({
            path: entry.path,
            line: line + 1,
            column: Array.from(text.slice(0, offset)).length + 1,
            preview: text.slice(Math.max(0, offset - 60), offset + 180),
          });
      }
    }
    for (const match of matches.slice(0, 100))
      list.push({
        id: `file:${match.path}:${match.line}`,
        title: mode === "content" ? match.preview : fileName(match.path),
        fileName: fileName(match.path),
        detail: `${match.path}${match.line ? `:${match.line}:${match.column}` : ""}`,
        run: () => {
          if (!sessionId) {
            useFilePreview.getState().show(match.path, match.line, match.column);
            return;
          }
          const session = useSsh.getState().sessions.find((item) => item.id === sessionId);
          if (!session) {
            toast(t("pluginChat.targetDisconnected"), "error");
            return;
          }
          useWorkspace.getState().openEditor(session, match.path);
          if (match.line)
            useEditorLocation
              .getState()
              .reveal(`editor:${session.id}:${match.path}`, match.line, match.column);
        },
      });
    return list;
  }, [
    mode,
    definitions,
    t,
    settings.rightPanel,
    settings.theme,
    hosts,
    tabs,
    result,
    searchKey,
    path,
    entries,
    activeTabId,
    needle,
    sessionId,
  ]);

  const filtered = useMemo(() => {
    const words = needle.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return commands
      .filter(
        (command) =>
          mode === "content" ||
          words.every((word) =>
            `${command.title} ${command.detail ?? ""} ${command.id}`
              .toLocaleLowerCase()
              .includes(word),
          ),
      )
      .slice(0, 100);
  }, [commands, needle, mode]);
  const current = Math.min(index, Math.max(0, filtered.length - 1));
  useEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>(`[data-result-index="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const run = (command: Command | undefined) => {
    if (command) {
      close();
      command.run();
    }
  };

  return (
    <div
      className="td-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        className="td-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab") {
            const nodes = Array.from(
              panel.current?.querySelectorAll<HTMLElement>(
                'input,button:not([disabled]),[tabindex="0"]',
              ) ?? [],
            );
            const position = nodes.indexOf(document.activeElement as HTMLElement);
            if (nodes.length) {
              event.preventDefault();
              nodes[(position + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus();
            }
          }
        }}
      >
        <div className="td-palette__input">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-results`}
            aria-activedescendant={filtered[current] ? `${id}-${current}` : undefined}
            value={query}
            spellCheck={false}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
              setError("");
              setSearching(false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex(
                  Math.max(
                    0,
                    Math.min(filtered.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
                  ),
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                run(filtered[current]);
              }
            }}
          />
        </div>
        <div className="td-palette__hint">{t("palette.modes")}</div>
        {(mode === "files" || mode === "content") && (
          <div className="td-palette__scope">
            <Select
              label={t("palette.scope")}
              value={root?.id ?? ""}
              options={roots.map((item) => ({
                value: item.id,
                label: `${item.sessionId ? (sessions.find((session) => session.id === item.sessionId)?.title ?? t("pluginChat.remoteExecution")) : t("pluginChat.localExecution")} · ${item.path}`,
              }))}
              onChange={(value) => {
                setRootId(value);
                setIndex(0);
              }}
              disabled={!roots.length}
            />
            <IconButton
              label={t("palette.chooseFolder")}
              onClick={() => {
                void api
                  .pluginPickFolder(t("palette.chooseFolder"))
                  .then((folder) => {
                    if (folder) {
                      const existing = roots.find(
                        (item) => !item.sessionId && item.path === folder,
                      );
                      if (existing) setRootId(existing.id);
                      else {
                        setPicked({ id: "picked", path: folder, sessionId: null });
                        setRootId("picked");
                      }
                    }
                  })
                  .catch((cause) => setError(translateError(cause)));
              }}
            >
              <FolderOpen size={15} />
            </IconButton>
          </div>
        )}
        <div
          className="td-palette__list"
          role="listbox"
          id={`${id}-results`}
          aria-label={t("palette.title")}
          aria-busy={searching}
        >
          {error && (
            <p className="td-palette__empty" role="alert">
              {error}
            </p>
          )}
          {!filtered.length && !error && (
            <p className="td-palette__empty">
              {searching
                ? t("common.loading")
                : mode === "files" || mode === "content"
                  ? !root
                    ? t("palette.noRoot")
                    : Array.from(needle).length < 2
                      ? t("palette.typeMore")
                      : t("palette.empty")
                  : t("palette.empty")}
            </p>
          )}
          {filtered.map((command, position) => (
            <button
              key={command.id}
              id={`${id}-${position}`}
              data-result-index={position}
              tabIndex={-1}
              type="button"
              role="option"
              aria-selected={position === current}
              className={cn("td-palette__item", position === current && "is-active")}
              onMouseEnter={() => setIndex(position)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(command)}
            >
              {command.fileName ? <FileTypeIcon icon={resolveFileIcon(command.fileName)} /> : null}
              <span className="td-palette__label">
                <span>{command.title}</span>
                {command.detail && <small title={command.detail}>{command.detail}</small>}
              </span>
              {bindingsFor(command.id, settings.keyboardShortcuts, undefined, definitions)[0] && (
                <kbd aria-hidden="true" className="td-palette__shortcut">
                  {displayShortcut(
                    bindingsFor(command.id, settings.keyboardShortcuts, undefined, definitions)[0]!,
                  )}
                </kbd>
              )}
            </button>
          ))}
        </div>
        {result?.key === searchKey && (result.limited || result.skipped > 0) && (
          <div className="td-palette__hint" role="status">
            {t("palette.limits", { count: result.skipped })}
          </div>
        )}
      </div>
    </div>
  );
}
