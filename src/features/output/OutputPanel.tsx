import { ArrowDownToLine, ListFilter, Search, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Menu, type MenuAction } from "@/components/ui/overlay/Menu";
import { useTabBarContribution } from "@/store/tabBar";
import { IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { formatOutput, formatOutputTime, matchesOutput, type OutputEntry } from "./model";
import { useOutput } from "./useOutput";
import "./output.css";

const OutputLine = memo(function OutputLine({ entry }: { entry: OutputEntry }) {
  const time = formatOutputTime(entry.timestamp);
  const message = entry.message.trimEnd();
  return (
    <span className={`output-panel__line is-${entry.level.toLowerCase()}`}>
      {time ? <span className="output-panel__time">{time} </span> : null}
      <span className="output-panel__level">[{entry.level}]</span>{" "}
      <span className="output-panel__source">[{entry.plugin ?? entry.domain}]</span>
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

export function OutputPanel({ active, docked = false }: { active: boolean; docked?: boolean }) {
  const { t } = useTranslation();
  const output = useOutput(active);
  const [channel, setChannel] = useState("all");
  const [query, setQuery] = useState("");
  const [minimum, setMinimum] = useState("TRACE");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const plugins = usePlugins((state) => state.items);
  const info = useSettings((state) => state.info);
  const sessions = useSsh((state) => state.sessions);
  const channels = useMemo(() => {
    const domains = [...new Set(output.entries.map((entry) => entry.domain))].sort();
    const pluginIds = [
      ...new Set([
        ...plugins.map((plugin) => plugin.id),
        ...output.entries.flatMap((entry) => (entry.plugin ? [entry.plugin] : [])),
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
  }, [output.entries, plugins, t]);
  // Preserve a selected channel even after its last displayed entry is cleared.
  const options = channels.some((item) => item.value === channel)
    ? channels
    : [...channels, { value: channel, label: channel.replace(/^(domain|plugin):/, "") }];
  const filtered = useMemo(
    () => output.entries.filter((entry) => matchesOutput(entry, channel, query, minimum)),
    [output.entries, channel, query, minimum],
  );
  const runtime = [
    `${info?.name ?? "Tunnelde"} ${info?.version ?? ""}`.trim(),
    `${t("output.platform")}: ${info ? `${info.os} · ${info.arch} · Tauri ${info.tauriVersion}` : "—"}`,
    `${t("output.build")}: ${info ? t(info.debug ? "output.debug" : "output.release") : "—"}`,
    `${t("output.sessions")}: ${sessions.length}`,
    `${t("output.plugins")}: ${plugins.filter((item) => item.status === "running").length} / ${plugins.length}`,
    ...plugins.map(
      (plugin) =>
        `${plugin.name} ${plugin.version} · ${plugin.status}${plugin.error ? ` · ${plugin.error}` : ""}`,
    ),
  ].filter((line) => line.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const renderedText =
    channel === "runtime" ? runtime.join("\n") : filtered.map(formatOutput).join("\n");

  useEffect(() => {
    if (active && follow && scroll.current)
      scroll.current.scrollTop = channel === "runtime" ? 0 : scroll.current.scrollHeight;
  }, [active, follow, renderedText, wrap, channel]);
  const attempt = (action: () => Promise<unknown>) =>
    void action().catch((error) => toast(translateError(error), "error"));

  const menuActions: MenuAction[] = [
    { label: t("common.refresh"), onSelect: output.refresh },
    {
      label: t("output.copy"),
      disabled: !renderedText,
      onSelect: () => attempt(() => api.clipboardWriteText(renderedText)),
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
      onSelect: () => attempt(api.openLatestLog),
    },
    { label: t("logs.openFolder"), onSelect: () => attempt(api.openLogDir) },
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
        onClick={output.clear}
      >
        <Trash2 size={14} />
      </IconButton>
      <Menu label={t("output.actions")} items={menuActions} />
    </div>
  );
  useTabBarContribution("sidebar:output", "output.actions", docked ? controls : null, 100, {
    group: "output.actions",
    overflowActions: [
      {
        label: t("output.follow"),
        checked: follow,
        checkable: "checkbox",
        onSelect: () => setFollow((value) => !value),
      },
      { label: t("output.clear"), disabled: channel === "runtime", onSelect: output.clear },
      ...menuActions,
    ],
  });
  const channelControl = (
    <Select
      className="tabbar-contribution__select"
      label={t("output.channel")}
      value={channel}
      options={options}
      onChange={setChannel}
    />
  );
  useTabBarContribution("sidebar:output", "output.channel", docked ? channelControl : null, 200, {
    group: "output.channel",
    overflowActions: options.map((option) => ({
      label: `${t("output.channel")}: ${option.label}`,
      checked: channel === option.value,
      checkable: "radio",
      onSelect: () => setChannel(option.value),
    })),
  });

  return (
    <section className="output-panel" aria-label={t("output.title")}>
      {!docked ? (
        <header className="sidebar__head output-panel__header">
          <SidebarTitle view="output">{t("output.title")}</SidebarTitle>
          {controls}
          <SidebarDockControls view="output" />
        </header>
      ) : null}
      {!docked ? (
        <div className="output-panel__toolbar">
          <Select
            className="output-panel__channel"
            label={t("output.channel")}
            value={channel}
            options={options}
            onChange={setChannel}
          />
        </div>
      ) : null}
      <div className="output-panel__filters">
        <label className="output-panel__search">
          <Search size={13} aria-hidden="true" />
          <input
            className="td-input"
            aria-label={t("output.search")}
            placeholder={t("output.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
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
      </div>
      {output.error ? (
        <div className="output-panel__error" role="alert">
          {output.error}
        </div>
      ) : null}
      <div
        className="output-panel__scroll"
        ref={scroll}
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
            <span>{t(output.entries.length ? "output.noMatches" : "output.empty")}</span>
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
