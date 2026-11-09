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
import { SearchFilterMenu } from "@/components/ui/form/SearchField";
import {
  matchesSearch,
  matchesSearchNumber,
  parseSearchQuery,
  searchQueryText,
  searchText,
} from "@/lib/search/query";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import { matchesPreview, previewKind, previewProviders } from "@/lib/files/preview";
import { inSearchRoot, searchParent, searchPathKey } from "@/lib/files/searchPaths";
import "@/styles/shortcuts.css";

interface Command {
  id: string;
  title: string;
  detail?: string;
  fileName?: string;
  filePath?: string;
  run: () => void;
}
type Match = Awaited<ReturnType<typeof api.filesSearch>>["matches"][number];

function fileSearchFields(path: string, name = fileName(path)) {
  const dot = name.lastIndexOf(".");
  return {
    name: (value: string) => searchText(name).includes(value),
    ext: dot > 0 ? name.slice(dot + 1) : "",
    path: (value: string) => searchText(path).includes(value),
  };
}

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
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
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
  const rawNeedle = (mode === "files" ? query : query.slice(1)).trim();
  const parsedQuery = useMemo(
    () =>
      parseSearchQuery(
        rawNeedle,
        mode === "commands"
          ? ["id", "category", "plugin"]
          : mode === "hosts"
            ? ["name", "host", "user", "tag", "is", "port"]
            : ["name", "path", "ext"],
      ),
    [rawNeedle, mode],
  );
  const needle = searchQueryText(
    rawNeedle,
    mode === "commands"
      ? ["id", "category", "plugin"]
      : mode === "hosts"
        ? ["name", "host", "user", "tag", "is", "port"]
        : ["name", "path", "ext"],
  );
  const selection = useMemo(
    () =>
      mode === "content"
        ? parsedQuery.filters.length
          ? { text: [], filters: parsedQuery.filters }
          : undefined
        : mode === "files" && (parsedQuery.filters.length || parsedQuery.text.length > 1)
          ? parsedQuery
          : undefined,
    [mode, parsedQuery],
  );
  const canSearch = Array.from(needle).length >= 2 || (mode === "files" && !!selection);
  const definitions = useMemo(() => shortcutCommands(plugins), [plugins]);
  const roots = useMemo(() => {
    const candidates = [
      ...Object.values(published).flat(),
      ...Object.values(entries).map((entry) => ({
        id: `editor:${entry.tabId}`,
        tabId: entry.tabId,
        sessionId: entry.sessionId,
        path: searchParent(entry.path, entry.sessionId),
      })),
      ...(picked ? [picked] : []),
    ];
    candidates.sort((a, b) => Number(b.tabId === activeTabId) - Number(a.tabId === activeTabId));
    const seen = new Set<string>();
    return candidates.filter((root) => {
      const key = `${root.sessionId ?? "local"}\0${searchPathKey(root.path, root.sessionId)}`;
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
  const searchKey = `${mode}\0${sessionId}\0${path}\0${needle}\0${JSON.stringify(selection)}`;
  const searching = pendingKey === searchKey;
  const error = failure?.key === searchKey ? failure.message : "";

  useEffect(() => {
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);
  useEffect(() => {
    if (!["files", "content"].includes(mode) || !path || !canSearch) return;
    let disposed = false;
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      setPendingKey(searchKey);
      setFailure(null);
      void api
        .filesSearch(
          requestId,
          sessionId,
          path,
          needle,
          mode === "content",
          ...(selection ? ([selection] as const) : []),
        )
        .then((response) => {
          if (!disposed) {
            setResult({ ...response, key: searchKey });
            setIndex(0);
          }
        })
        .catch((cause) => {
          if (!disposed) setFailure({ key: searchKey, message: translateError(cause) });
        })
        .finally(() => {
          if (!disposed) setPendingKey(null);
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void api.filesSearchCancel(requestId).catch(() => {});
    };
  }, [mode, needle, path, sessionId, searchKey, canSearch, selection]);

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
          detail: `Category: ${item.plugin ? "Plugins" : item.scope === "editor" ? "Editor" : item.id.startsWith("host.") ? "Hosts" : item.id.startsWith("sidebar.forwarding") ? "Port Forwarding" : item.id.startsWith("tab.") || item.id.startsWith("pane.") || item.id.startsWith("sidebar.") || item.id.startsWith("panel.") ? "View" : item.id.startsWith("theme.") || item.id.startsWith("font.") || item.id === "page.settings" || item.id === "keyboard.shortcuts" ? "Preferences" : "Application"}`,
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
              filePath: entries[tab.id]?.path,
              detail: t("palette.openTab"),
              run: () => useWorkspace.getState().activate(tab.id),
            }))
        : [];
    const visible = result?.key === searchKey ? result.matches : [];
    const drafts =
      mode === "content" && needle.length >= 2
        ? Object.values(entries).filter(
            (entry) =>
              entry.sessionId === sessionId &&
              !!path &&
              inSearchRoot(entry.path, path, sessionId) &&
              !entry.loading &&
              !entry.error &&
              matchesSearch(
                { text: [], filters: parsedQuery.filters },
                "",
                fileSearchFields(entry.path),
              ),
          )
        : [];
    const matches = [
      ...visible.filter(
        (match) =>
          !drafts.some(
            (entry) =>
              searchPathKey(entry.path, sessionId) === searchPathKey(match.path, sessionId),
          ),
      ),
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
        filePath: match.path,
        detail: `${match.path}${match.line ? `:${match.line}:${match.column}` : ""}`,
        run: () => {
          const provider = previewProviders(usePlugins.getState().items).find((item) =>
            matchesPreview(item, match.path),
          );
          if ((provider?.renderer ?? previewKind(match.path)) !== "text") {
            useFilePreview
              .getState()
              .show(
                match.path,
                match.line,
                match.column,
                sessionId ? { kind: "remote", sessionId } : { kind: "local" },
              );
            return;
          }
          if (!sessionId) {
            useWorkspace.getState().openLocalEditor(match.path);
            if (match.line)
              useEditorLocation
                .getState()
                .reveal(`editor-local:${match.path}`, match.line, match.column);
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
    parsedQuery,
  ]);

  const filtered = useMemo(() => {
    return commands
      .filter((command) => {
        const host =
          mode === "hosts"
            ? hosts.find(
                (host) =>
                  command.id === `host.connect.${host.id}` || command.id === `host.open.${host.id}`,
              )
            : null;
        return matchesSearch(
          mode === "content" ? { ...parsedQuery, text: [] } : parsedQuery,
          `${command.title} ${command.detail ?? ""} ${command.id}`,
          {
            id: command.id,
            category: command.detail?.replace(/^Category: /, ""),
            plugin: definitions.find((item) => item.id === command.id)?.plugin?.id,
            name: (value) =>
              searchText(host?.name ?? command.fileName ?? command.title).includes(value),
            host: (value) => !!host && searchText(host.host).includes(value),
            user: host?.username,
            tag: host?.tags,
            is: host?.favorite ? ["favorite"] : [],
            port: (value) => matchesSearchNumber(host?.port, value),
            ext: fileSearchFields(command.filePath ?? "", command.fileName ?? "").ext,
            path: (value) => !!command.filePath && searchText(command.filePath).includes(value),
          },
        );
      })
      .slice(0, 100);
  }, [commands, parsedQuery, mode, hosts, definitions]);
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
              setFailure(null);
              setPendingKey(null);
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
          <SearchFilterMenu
            query={rawNeedle}
            filterKeys={
              mode === "commands"
                ? ["id", "category", "plugin"]
                : mode === "hosts"
                  ? ["name", "host", "user", "tag", "is", "port"]
                  : ["name", "path", "ext"]
            }
            onChange={(value) => {
              setQuery(
                (mode === "files"
                  ? ""
                  : mode === "commands"
                    ? ">"
                    : mode === "content"
                      ? "%"
                      : "@") + value,
              );
              setIndex(0);
            }}
            focusInput={() => input.current?.focus()}
            presets={
              mode === "commands"
                ? [
                    { key: "id", value: "", label: t("searchUi.id") },
                    ...[
                      "Application",
                      "View",
                      "Preferences",
                      "Hosts",
                      "Editor",
                      "Plugins",
                      "Port Forwarding",
                    ].map((category) => ({
                      key: "category",
                      value: category,
                      label: category,
                      exclusive: true,
                    })),
                    ...plugins.map((plugin) => ({
                      key: "plugin",
                      value: plugin.id,
                      label: plugin.name,
                    })),
                  ]
                : mode === "hosts"
                  ? [
                      { key: "is", value: "favorite", label: t("searchUi.favorite") },
                      { key: "host", value: "", label: t("searchUi.host") },
                      { key: "user", value: "", label: t("searchUi.user") },
                      ...[...new Set(hosts.flatMap((host) => host.tags))].map((tag) => ({
                        key: "tag",
                        value: tag,
                        label: tag,
                      })),
                    ]
                  : [
                      { key: "ext", value: "", label: t("searchUi.extension") },
                      { key: "path", value: "", label: t("searchUi.path") },
                      { key: "name", value: "", label: t("searchUi.name") },
                    ]
            }
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
                        (item) =>
                          !item.sessionId &&
                          searchPathKey(item.path, null) === searchPathKey(folder, null),
                      );
                      if (existing) setRootId(existing.id);
                      else {
                        setPicked({ id: "picked", path: folder, sessionId: null });
                        setRootId("picked");
                      }
                    }
                  })
                  .catch((cause) => setFailure({ key: searchKey, message: translateError(cause) }));
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
                    : !canSearch
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
