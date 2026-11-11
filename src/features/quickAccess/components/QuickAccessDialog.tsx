import { FolderOpen, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuickAccess } from "@/store/quickAccess";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { SearchFilterMenu } from "@/components/ui/form/SearchField";
import { QUICK_ACCESS_PAGE_SIZE, useQuickAccessController } from "../runtime/useController";
import { QuickAccessEntries } from "./QuickAccessEntries";
import { QuickAccessSurface } from "./QuickAccessSurface";
import "@/styles/shortcuts.css";
export function CommandPalette() {
  const query = useQuickAccess((state) => state.query);
  const generation = useQuickAccess((state) => state.generation);
  return query === null ? null : (
    <QuickAccessDialog initialQuery={query} key={`${generation}:${query}`} />
  );
}
function QuickAccessDialog({ initialQuery }: { initialQuery: string }) {
  const { t } = useTranslation();
  const manager = useQuickAccessController(initialQuery);
  const {
    query,
    setQuery,
    index: current,
    setIndex,
    mode,
    rawNeedle,
    hosts,
    plugins,
    roots,
    root,
    sessions,
    setRootId,
    canSearch,
    filtered,
    offset,
    result,
    limited,
    searchKey,
    searching,
    error,
    close,
    runNative,
    chooseFolder,
  } = manager;
  const input = useRef<HTMLInputElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  const id = useId();
  useLayoutEffect(() => {
    // Paging/provider changes can remove the focused button. Keep modal keyboard
    // ownership when the browser returns focus to body after that removal.
    if (document.activeElement === document.body) input.current?.focus();
  });
  useEffect(() => {
    input.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [previous]);
  useEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>(`[data-result-index="${current}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
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
            maxLength={4096}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
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
                runNative(filtered[current]);
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
                      : "@ ") + value,
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
            <IconButton label={t("palette.chooseFolder")} onClick={chooseFolder}>
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
          <QuickAccessSurface manager={manager}>
            <QuickAccessEntries manager={manager} id={id} />
          </QuickAccessSurface>
        </div>
        {filtered.length > QUICK_ACCESS_PAGE_SIZE && (
          <div className="td-palette__paging">
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setIndex(Math.max(0, offset - QUICK_ACCESS_PAGE_SIZE))}
            >
              {t("palette.previousPage")}
            </Button>
            <span role="status">
              {offset + 1}–{Math.min(offset + QUICK_ACCESS_PAGE_SIZE, filtered.length)} /{" "}
              {filtered.length}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + QUICK_ACCESS_PAGE_SIZE >= filtered.length}
              onClick={() => setIndex(offset + QUICK_ACCESS_PAGE_SIZE)}
            >
              {t("palette.nextPage")}
            </Button>
          </div>
        )}
        {(limited || (result?.key === searchKey && result.skipped > 0)) && (
          <div className="td-palette__hint" role="status">
            {t("palette.limits", { count: result?.key === searchKey ? result.skipped : 0 })}
          </div>
        )}
      </div>
    </div>
  );
}
