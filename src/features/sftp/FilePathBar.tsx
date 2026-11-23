import { ChevronRight, Folder, History } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Menu } from "@/components/ui/overlay/Menu";
import type { FileEntry, FsSource } from "@/lib/api/types";
import { presentError } from "@/lib/api/errors";
import { fs, sourceKey } from "@/lib/files/fs";
import { pathCrumbs } from "@/lib/files/navigation";
import { visibleFiles, type FileViewPreferences } from "@/lib/files/view";

function ChildFolders({
  path,
  source,
  view,
  onNavigate,
  list,
}: {
  path: string;
  source: FsSource;
  view: FileViewPreferences;
  onNavigate: (path: string) => void;
  list: typeof fs.list;
}) {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<{ entries?: FileEntry[]; error?: string }>({});
  const request = useRef(0);
  const folders = useMemo(
    () =>
      visibleFiles(
        result.entries ?? [],
        view,
        new Intl.Collator(i18n.resolvedLanguage, { numeric: true, sensitivity: "base" }),
        [],
        { query: "", kind: "folders" },
      ),
    [result.entries, view, i18n.resolvedLanguage],
  );
  const load = async () => {
    const version = ++request.current;
    setResult({});
    try {
      const listing = await list(source, path);
      if (request.current === version) setResult({ entries: listing.entries });
    } catch (error) {
      if (request.current === version) setResult({ error: presentError(error) });
    }
  };
  return (
    <Menu
      label={t("sftp.childFolders", { path })}
      trigger={<ChevronRight size={12} />}
      className="sftp-path__expand"
      menuClassName="sftp-path__menu"
      onOpen={() => void load()}
      items={
        result.error
          ? [
              { label: result.error, disabled: true, onSelect: () => undefined },
              { label: t("sftp.refresh"), keepOpen: true, onSelect: () => void load() },
            ]
          : !result.entries
            ? [{ label: t("sftp.loading"), disabled: true, onSelect: () => undefined }]
            : folders.length
              ? folders.map((entry) => ({
                  label: entry.name,
                  icon: <Folder size={13} />,
                  onSelect: () => onNavigate(entry.path),
                }))
              : [{ label: t("sftp.noSubfolders"), disabled: true, onSelect: () => undefined }]
      }
    />
  );
}

export function FilePathBar({
  source,
  path,
  draft,
  editing,
  busy,
  view,
  history,
  onDraft,
  onEditing,
  onFinishEditing,
  onNavigate,
  list = fs.list,
  captureKey,
  preserveDraftOnBlur,
}: {
  source: FsSource;
  path: string;
  draft: string;
  editing: boolean;
  busy: boolean;
  view: FileViewPreferences;
  history: string[];
  onDraft: (value: string | null) => void;
  onEditing: (editing: boolean) => void;
  onFinishEditing: () => void;
  onNavigate: (path: string) => void;
  list?: typeof fs.list;
  captureKey?: string;
  preserveDraftOnBlur?: () => boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const breadcrumbs = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const historyPointer = useRef(false);
  const crumbs = useMemo(() => pathCrumbs(path, source), [path, source]);
  useLayoutEffect(() => {
    if (editing) {
      historyPointer.current = false;
      input.current?.focus();
      input.current?.select();
    } else if (breadcrumbs.current) {
      breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
    }
  }, [editing, path]);
  const cancel = useCallback(() => {
    historyPointer.current = false;
    onDraft(null);
    onEditing(false);
  }, [onDraft, onEditing]);
  const ownHistoryMenu = useCallback(() => {
    const menuId = root.current
      ?.querySelector<HTMLButtonElement>(".sftp-path__history-trigger[aria-controls]")
      ?.getAttribute("aria-controls");
    return menuId ? document.getElementById(menuId) : null;
  }, []);
  const inHistoryMenu = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      const menu = ownHistoryMenu();
      return !!menu && menu.contains(target);
    },
    [ownHistoryMenu],
  );
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.current?.contains(target) || inHistoryMenu(target))
        return;
      cancel();
    };
    const finishHistoryPointer = () => {
      if (!historyPointer.current) return;
      historyPointer.current = false;
      requestAnimationFrame(() => {
        if (ownHistoryMenu()) return;
        cancel();
      });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", finishHistoryPointer, true);
    document.addEventListener("pointercancel", finishHistoryPointer, true);
    document.addEventListener("mouseup", finishHistoryPointer, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", finishHistoryPointer, true);
      document.removeEventListener("pointercancel", finishHistoryPointer, true);
      document.removeEventListener("mouseup", finishHistoryPointer, true);
    };
  }, [cancel, editing, inHistoryMenu, ownHistoryMenu]);
  return (
    <div className="sftp-pane__path">
      <div
        ref={root}
        className="sftp-path"
        onBlur={(event) => {
          if (preserveDraftOnBlur?.()) return;
          if (historyPointer.current) {
            return;
          }
          const next = event.relatedTarget;
          if (next instanceof Node && (event.currentTarget.contains(next) || inHistoryMenu(next)))
            return;
          cancel();
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            inHistoryMenu(event.target)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
          onFinishEditing();
        }}
      >
        {editing ? (
          <input
            ref={input}
            data-panel-focus={captureKey ? `${captureKey}:path` : undefined}
            className="td-input sftp-path__input"
            aria-label={t("sftp.path")}
            value={draft}
            spellCheck={false}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (draft.trim()) {
                  onNavigate(draft.trim());
                  onEditing(false);
                  onFinishEditing();
                }
              }
            }}
          />
        ) : (
          <>
            <div className="sftp-path__crumbs" ref={breadcrumbs} aria-label={t("sftp.path")}>
              {crumbs.map((crumb, index) => (
                <span className="sftp-path__segment" key={crumb.path}>
                  <button
                    type="button"
                    className="sftp-path__crumb"
                    title={crumb.path}
                    aria-current={index === crumbs.length - 1 ? "location" : undefined}
                    disabled={busy}
                    onClick={() => onNavigate(crumb.path)}
                  >
                    {crumb.name}
                  </button>
                  <ChildFolders
                    list={list}
                    key={`${sourceKey(source)}:${crumb.path}`}
                    path={crumb.path}
                    source={source}
                    view={view}
                    onNavigate={onNavigate}
                  />
                </span>
              ))}
            </div>
            <button
              type="button"
              className="sftp-path__edit"
              aria-label={t("sftp.editPath")}
              title={path}
              onClick={() => onEditing(true)}
            />
          </>
        )}
        {editing && history.length > 0 ? (
          <span
            className="sftp-path__history"
            onMouseDownCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest(".sftp-path__history-trigger")
              ) {
                historyPointer.current = true;
                event.preventDefault();
              }
            }}
          >
            <Menu
              label={t("sftp.recentPaths")}
              trigger={<History size={13} />}
              className="sftp-path__history-trigger"
              menuClassName="sftp-path__history-menu"
              items={[...new Set(history)]
                .reverse()
                .slice(0, 20)
                .map((value) => ({
                  label: value,
                  onSelect: () => {
                    onNavigate(value);
                    onEditing(false);
                    onFinishEditing();
                  },
                }))}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}
