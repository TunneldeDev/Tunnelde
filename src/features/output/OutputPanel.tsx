import { usePanelViewState } from "@/lib/panels/viewState";
import { useRemoteOutputModel } from "@/lib/panels/outputModel";
import { ArrowDownToLine, ListFilter, Trash2 } from "lucide-react";
import { SearchToolbar } from "@/components/ui/layout/SearchToolbar";
import { matchesSearch, parseSearchQuery } from "@/lib/search/query";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Menu, type MenuAction } from "@/components/ui/overlay/Menu";
import { IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { PanelHeader, useWorkbenchPanel } from "@/components/layout/WorkbenchPanel";
import { api } from "@/lib/api/ipc";
import { presentError } from "@/lib/api/errors";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { getLocalDiagnostics, subscribeLocalDiagnostics } from "@/lib/diagnostics";
import {
  formatOutput,
  formatOutputTime,
  localDiagnosticEntry,
  matchesOutput,
  mergeOutput,
  type OutputEntry,
} from "./model";
import { useOutput } from "./useOutput";
import "./output.css";

const OutputLine = memo(function OutputLine({ entry }: { entry: OutputEntry }) {
  const { t } = useTranslation();
  const time = formatOutputTime(entry.timestamp);
  const message = entry.message.trimEnd();
  return (
    <span className={`output-panel__line is-${entry.level.toLowerCase()}`}>
      {time ? <span className="output-panel__time">{time} </span> : null}
      <span className="output-panel__level">[{entry.level}]</span>{" "}
      <span className="output-panel__source">[{entry.plugin ?? entry.domain}]</span>
      {entry.memoryOnly ? ` [${t("diagnostic.unsaved")}]` : null}
      {message ? (
        <>
          {" "}
          <span className="output-panel__message">{message}</span>
        </>
      ) : null}
      {"\n"}
    </span>
  );
});

export function OutputPanel({ active }: { active: boolean; docked?: boolean }) {
  const { t } = useTranslation();
  const scope = useWorkbenchPanel();
  const remote = useRemoteOutputModel();
  const local = useOutput(active && !remote);
  const output = remote ?? local;
  const [clearedAt, setClearedAt] = useState(0);
  const localDiagnostics = useSyncExternalStore(subscribeLocalDiagnostics, getLocalDiagnostics);
  const entries = useMemo(
    () =>
      mergeOutput(
        output.entries,
        localDiagnostics.flatMap((row, index) =>
          row.delivery === "memory" && Date.parse(row.event.timestamp) > clearedAt
            ? [localDiagnosticEntry(row.event, -index - 1)]
            : [],
        ),
      ),
    [output.entries, localDiagnostics, clearedAt],
  );
  const [channel, setChannel] = usePanelViewState(
    "output.channel",
    "all",
    (v): v is string => typeof v === "string",
  );
  const [query, setQuery] = usePanelViewState(
    "output.query",
    "",
    (v): v is string => typeof v === "string",
  );
  const [minimum, setMinimum] = usePanelViewState(
    "output.minimum",
    "TRACE",
    (v): v is string => typeof v === "string",
  );
  const [follow, setFollow] = usePanelViewState(
    "output.follow",
    true,
    (v): v is boolean => typeof v === "boolean",
  );
  const [wrap, setWrap] = usePanelViewState(
    "output.wrap",
    false,
    (v): v is boolean => typeof v === "boolean",
  );
  const scroll = useRef<HTMLDivElement>(null);
  const localPlugins = usePlugins((state) => state.items);
  const plugins = remote?.plugins ?? localPlugins;
  const localInfo = useSettings((state) => state.info);
  const info = remote ? remote.info : localInfo;
  const sessions = useSsh((state) => state.sessions);
  const sessionCount = remote?.sessionCount ?? sessions.length;
  const channels = useMemo(() => {
    const domains = [...new Set(entries.map((entry) => entry.domain))].sort();
    const pluginIds = [
      ...new Set([
        ...plugins.map((plugin) => plugin.id),
        ...entries.flatMap((entry) => (entry.plugin ? [entry.plugin] : [])),
      ]),
    ].sort();
    return [
      { value: "all", label: t("output.all") },
      { value: "application", label: t("logs.diagnostic") },
      { value: "operations", label: t("logs.operations") },
      { value: "runtime", label: t("output.runtime") },
      ...domains.map((domain) => ({
        value: `domain:${domain}`,
        label: `${t("output.domain")}: ${domain}`,
      })),
      ...pluginIds.map((id) => ({
        value: `plugin:${id}`,
        label: `${t("output.plugin")}: ${plugins.find((item) => item.id === id)?.name ?? id}`,
      })),
    ];
  }, [entries, plugins, t]);
  // Preserve a selected channel even after its last displayed entry is cleared.
  const options = channels.some((item) => item.value === channel)
    ? channels
    : [...channels, { value: channel, label: channel.replace(/^(domain|plugin):/, "") }];
  const parsed = useMemo(
    () => parseSearchQuery(query, ["level", "domain", "plugin", "source"]),
    [query],
  );
  const filtered = useMemo(
    () => entries.filter((entry) => matchesOutput(entry, channel, parsed, minimum)),
    [entries, channel, parsed, minimum],
  );
  const runtime = [
    `${info?.name ?? "Tunnelde"} ${info?.version ?? ""}`.trim(),
    `${t("output.platform")}: ${info ? `${info.os} · ${info.arch} · Tauri ${info.tauriVersion}` : "—"}`,
    `${t("output.build")}: ${info ? t(info.debug ? "output.debug" : "output.release") : "—"}`,
    `${t("output.sessions")}: ${sessionCount}`,
    `${t("output.plugins")}: ${plugins.filter((item) => item.status === "running").length} / ${plugins.length}`,
    ...plugins.map(
      (plugin) =>
        `${plugin.name} ${plugin.version} · ${plugin.status}${plugin.error ? ` · ${plugin.error}` : ""}`,
    ),
  ].filter((line, index) =>
    matchesSearch(parsed, line, {
      domain: "runtime",
      source: "runtime",
      plugin: index >= 5 ? plugins[index - 5]?.id : null,
    }),
  );
  const renderedText =
    channel === "runtime"
      ? runtime.join("\n")
      : filtered
          .map((entry) =>
            entry.memoryOnly
              ? `[${t("diagnostic.unsaved")}] ${formatOutput(entry)}`
              : formatOutput(entry),
          )
          .join("\n");

  useEffect(() => {
    if (active && follow && scroll.current)
      scroll.current.scrollTop = channel === "runtime" ? 0 : scroll.current.scrollHeight;
  }, [active, follow, renderedText, wrap, channel]);
  const attempt = (action: () => Promise<unknown>) =>
    void action().catch((error) => toast(presentError(error), "error"));

  const menuActions: MenuAction[] = [
    { label: t("common.refresh"), onSelect: () => attempt(output.refresh) },
    {
      label: t("output.copy"),
      disabled: !renderedText,
      onSelect: () =>
        attempt(() => (remote ? remote.copy(renderedText) : api.clipboardWriteText(renderedText))),
    },
    {
      label: t("output.wrap"),
      checked: wrap,
      checkable: "checkbox",
      onSelect: () => setWrap((value) => !value),
    },
    {
      label: t("output.openFile"),
      separatorBefore: true,
      onSelect: () => attempt(remote?.openLatest ?? api.openLatestLog),
    },
    {
      label: t("logs.openFolder"),
      onSelect: () => attempt(remote?.openDirectory ?? api.openLogDir),
    },
  ];
  const controls = (
    <div className="output-panel__actions">
      <IconButton
        size="sm"
        label={t("output.follow")}
        active={follow}
        aria-pressed={follow}
        onClick={() => setFollow((value) => !value)}
      >
        <ArrowDownToLine size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("output.clear")}
        disabled={channel === "runtime"}
        onClick={() =>
          attempt(async () => {
            await output.clear();
            setClearedAt(Date.now());
          })
        }
      >
        <Trash2 size={14} />
      </IconButton>
      <Menu label={t("output.actions")} items={menuActions} />
    </div>
  );

  return (
    <section className="output-panel" aria-label={scope ? undefined : t("output.title")}>
      <PanelHeader view="output" />
      <SearchToolbar
        className="output-panel__filters"
        aria-label={t("output.search")}
        filterKeys={["level", "domain", "plugin", "source"]}
        placeholder={t("output.search")}
        value={query}
        onChange={setQuery}
        presets={[
          ...["ERROR", "WARN", "INFO", "DEBUG", "TRACE"].map((level) => ({
            key: "level",
            value: level,
            label: level,
          })),
          ...[...new Set(entries.map((entry) => entry.domain))].sort().map((domain) => ({
            key: "domain",
            value: domain,
            label: `${t("searchUi.domain")}: ${domain}`,
          })),
          ...plugins.map((plugin) => ({ key: "plugin", value: plugin.id, label: plugin.name })),
          { key: "source", value: "application", label: t("logs.diagnostic") },
          { key: "source", value: "operations", label: t("logs.operations") },
          { key: "source", value: "runtime", label: t("output.runtime") },
        ]}
        actions={
          <>
            <Select
              className="output-panel__channel"
              label={t("output.channel")}
              value={channel}
              options={options}
              onChange={setChannel}
            />
            <Select
              label={t("output.level")}
              value={minimum}
              disabled={channel === "runtime"}
              options={[
                { value: "TRACE", label: t("output.allLevels") },
                ...["DEBUG", "INFO", "WARN", "ERROR"].map((value) => ({ value, label: value })),
              ]}
              onChange={setMinimum}
            />
            {controls}
          </>
        }
      />
      {output.diskUnavailable ||
      entries.some((entry) => entry.memoryOnly) ||
      output.diagnosticError ||
      output.operationsError ||
      output.error ? (
        <div className="output-panel__error" role="alert">
          {(output.diskUnavailable || entries.some((entry) => entry.memoryOnly)) && (
            <div>{t("diagnostic.memoryOnly")}</div>
          )}
          {output.diagnosticError && <div>{t("diagnostic.readDiagnostic")}</div>}
          {output.operationsError && <div>{t("diagnostic.readOperations")}</div>}
          {output.error && <div>{output.error}</div>}
        </div>
      ) : null}
      <div
        className="output-panel__scroll"
        ref={scroll}
        data-panel-scroll="output.content"
        tabIndex={0}
        role="region"
        aria-label={t("output.content")}
        onScroll={() => {
          const element = scroll.current;
          if (element)
            setFollow(element.scrollHeight - element.clientHeight - element.scrollTop < 8);
        }}
      >
        {renderedText ? (
          <pre className={`output-panel__lines${wrap ? " is-wrapped" : ""}`}>
            {channel === "runtime"
              ? renderedText
              : filtered.map((entry) => <OutputLine key={entry.id} entry={entry} />)}
          </pre>
        ) : (
          <div className="output-panel__empty">
            <ListFilter size={20} />
            <span>{t(entries.length ? "output.noMatches" : "output.empty")}</span>
          </div>
        )}
      </div>
      <footer className="output-panel__footer">
        <span>
          {channel === "runtime"
            ? t("output.runtime")
            : t("output.count", { count: filtered.length })}
        </span>
        <span>
          {output.truncated
            ? t("output.bounded")
            : follow
              ? t("output.following")
              : t("output.scrollPaused")}
        </span>
      </footer>
    </section>
  );
}
