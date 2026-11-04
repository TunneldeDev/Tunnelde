import { ChevronRight, Folder, History } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Menu } from "@/components/ui/overlay/Menu";
import type { FileEntry, FsSource } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { fs, sourceKey } from "@/lib/files/fs";
import { pathCrumbs } from "@/lib/files/navigation";
import { visibleFiles, type FileViewPreferences } from "@/lib/files/view";

function ChildFolders({
  path,
  source,
  view,
  onNavigate,
}: {
  path: string;
  source: FsSource;
  view: FileViewPreferences;
  onNavigate: (path: string) => void;
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
      const listing = await fs.list(source, path);
      if (request.current === version) setResult({ entries: listing.entries });
    } catch (error) {
      if (request.current === version) setResult({ error: translateError(error) });
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
              { label: t("sftp.refresh"), onSelect: () => void load() },
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
  onNavigate,
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
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const breadcrumbs = useRef<HTMLDivElement>(null);
  const crumbs = useMemo(() => pathCrumbs(path, source), [path, source]);
  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (breadcrumbs.current) {
      breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
    }
  }, [editing, path]);
  const cancel = () => {
    onDraft(null);
    onEditing(false);
  };
  return (
    <div className="sftp-pane__path">
      <div className="sftp-path">
        {editing ? (
          <input
            ref={input}
            className="td-input sftp-path__input"
            aria-label={t("sftp.path")}
            value={draft}
            spellCheck={false}
            onChange={(event) => onDraft(event.target.value)}
            onBlur={(event) => {
              if (
                !event.currentTarget.parentElement?.contains(event.relatedTarget) &&
                !(event.relatedTarget instanceof Element && event.relatedTarget.closest(".td-menu"))
              )
                cancel();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (draft.trim()) {
                  onNavigate(draft.trim());
                  onEditing(false);
                }
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
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
          <Menu
            label={t("sftp.recentPaths")}
            trigger={<History size={13} />}
            items={[...new Set(history)]
              .reverse()
              .slice(0, 20)
              .map((value) => ({
                label: value,
                onSelect: () => {
                  onNavigate(value);
                  onEditing(false);
                },
              }))}
          />
        ) : null}
      </div>
    </div>
  );
}
