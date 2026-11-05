import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Package,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { OverlayScrollArea } from "@/components/ui/display/OverlayScrollArea";
import { matchesPlugin, pluginTags, PLUGIN_PAGE_SIZE } from "@/lib/plugins/discovery";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useMarketplace, boundTo, newerVersion } from "@/store/marketplace";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { toast } from "@/store/toasts";
import { LocalPluginInstall } from "./LocalPluginInstall";
import { requestMarketInstall } from "./PluginDetailPage";
import { PluginError } from "./PluginError";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";

export function PluginsSection({ sidebar = false }: { sidebar?: boolean }) {
  const { t, i18n } = useTranslation();
  const {
    config,
    catalogues,
    errors,
    loading,
    ready,
    configError,
    configLoading,
    query,
    tag,
    page,
    setTag,
    setPage,
    scope,
    tasks,
    setQuery,
    setScope,
    load,
  } = useMarketplace();
  const items = usePlugins((s) => s.items),
    busyIds = usePlugins((s) => s.busyIds),
    loadPlugins = usePlugins((s) => s.load);
  const active = useWorkspace((s) => s.activeId);
  const [installRequest, setInstallRequest] = useState(0);
  const id = useId();
  useEffect(() => {
    void load();
    void loadPlugins();
  }, [load, loadPlugins]);
  const sources = config.sources.filter((s) => s.enabled);
  const entries = sources.flatMap((source) =>
    (catalogues[source.id]?.entries ?? []).map((entry) => ({ entry, source })),
  );
  const updates = entries.filter(({ entry, source }) =>
    items.some(
      (p) => p.id === entry.id && boundTo(p, source) && newerVersion(entry.version, p.version),
    ),
  );
  const search = query.trim();
  const matches = (p: Parameters<typeof matchesPlugin>[0]) => matchesPlugin(p, query, tag);
  const tags = [
    ...new Set([...items, ...entries.map(({ entry }) => entry)].flatMap(pluginTags)),
  ].sort((a, b) => a.localeCompare(b));
  if (tag && !tags.includes(tag)) tags.unshift(tag);
  const rows =
    scope === "installed"
      ? items.filter(matches).map((p) => ({
          info: p,
          entry: null,
          source: config.sources.find((s) => boundTo(p, s)) ?? null,
          installed: p,
        }))
      : (scope === "updates" ? updates : entries)
          .filter(({ entry }) => matches(entry))
          .map(({ entry, source }) => ({
            info: entry,
            entry,
            source,
            installed: items.find((p) => p.id === entry.id),
          }));
  const pageCount = Math.max(1, Math.ceil(rows.length / PLUGIN_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(
    currentPage * PLUGIN_PAGE_SIZE,
    (currentPage + 1) * PLUGIN_PAGE_SIZE,
  );
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage, setPage]);
  useEffect(() => {
    document.getElementById(`${id}-list`)?.scrollTo?.({ top: 0 });
  }, [currentPage, query, tag, scope, id]);
  const tabs = [
    { key: "market", label: t("plugins.marketplace"), count: null },
    { key: "installed", label: t("plugins.installedTab"), count: items.length },
    { key: "updates", label: t("market.updates"), count: updates.length },
  ] as const;
  const openSettings = () => {
    useNavigation.getState().selectSettings("plugins");
    useWorkspace.getState().openPage("settings");
  };
  return (
    <section
      className={sidebar ? "plugins-sidebar" : "plugins-browser"}
      aria-label={t("settings.plugins")}
    >
      <header className="sidebar__head plugins-sidebar__head">
        <SidebarTitle view="plugins">{t("settings.plugins")}</SidebarTitle>
        <IconButton
          label={t("plugins.installTitle")}
          size="sm"
          onClick={() => setInstallRequest((n) => n + 1)}
        >
          <Plus size={14} />
        </IconButton>
        <IconButton
          label={t("market.refresh")}
          size="sm"
          disabled={configLoading || loading.length > 0}
          onClick={() => {
            void load(true);
            void loadPlugins();
          }}
        >
          <RefreshCw size={13} />
        </IconButton>
        <IconButton label={t("market.manageSources")} size="sm" onClick={openSettings}>
          <Settings2 size={14} />
        </IconButton>
        <SidebarDockControls view="plugins" />
      </header>
      <div className="sidebar__search">
        <div className="sidebar__filter">
          <Search size={13} aria-hidden="true" />
          <Input
            aria-label={t("plugins.search")}
            placeholder={t("plugins.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {tags.length > 0 ? (
          <div className="plugins-tag-filter">
            <Select
              label={t("market.tags")}
              value={tag}
              options={[
                { value: "", label: t("market.allTags") },
                ...tags.map((value) => ({ value, label: value })),
              ]}
              onChange={setTag}
            />
          </div>
        ) : null}
      </div>
      <div
        className="plugins-sidebar__tabs"
        role="tablist"
        aria-label={t("settings.plugins")}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const index = tabs.findIndex((tab) => tab.key === scope);
          const next =
            tabs[
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? 2
                  : (index + (e.key === "ArrowLeft" ? 2 : 1)) % 3
            ];
          if (next) {
            setScope(next.key);
            e.currentTarget.querySelector<HTMLButtonElement>(`[data-scope="${next.key}"]`)?.focus();
          }
        }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            id={`${id}-${tab.key}`}
            data-scope={tab.key}
            role="tab"
            aria-selected={scope === tab.key}
            aria-controls={`${id}-list`}
            tabIndex={scope === tab.key ? 0 : -1}
            onClick={() => setScope(tab.key)}
          >
            {tab.label}
            {tab.count !== null ? <span>{tab.count}</span> : null}
          </button>
        ))}
      </div>
      <OverlayScrollArea
        className="plugins-browser__list"
        role="tabpanel"
        id={`${id}-list`}
        aria-labelledby={`${id}-${scope}`}
        aria-busy={configLoading || loading.length > 0}
        onKeyDown={(e) => {
          if (
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) ||
            !(e.target as HTMLElement).matches(".extension-row__open")
          )
            return;
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>(".extension-row__open"),
          ];
          const at = buttons.indexOf(e.target as HTMLButtonElement);
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (at + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
          buttons[next]?.scrollIntoView?.({ block: "nearest" });
        }}
      >
        {configError ? (
          <div className="plugins-sidebar__empty">
            <PluginError message={configError} />
            <Button size="sm" onClick={() => void load(true)}>
              {t("market.retry")}
            </Button>
          </div>
        ) : null}
        {scope !== "installed"
          ? sources.map((s) =>
              errors[s.id] ? (
                <div className="plugins-browser__notice" key={s.id} role="status">
                  <strong>{s.name}</strong>
                  <p>{t("plugins.marketplaceUnavailable")}</p>
                  <PluginError message={errors[s.id]!} />
                  <Button size="sm" onClick={() => void load(true)}>
                    {t("market.retry")}
                  </Button>
                </div>
              ) : catalogues[s.id]?.stale ? (
                <p key={s.id} className="plugins-browser__notice">
                  {s.name} ·{" "}
                  {t("market.stale", {
                    time: new Date(catalogues[s.id]!.checkedAt).toLocaleString(
                      i18n.resolvedLanguage,
                    ),
                  })}
                </p>
              ) : null,
            )
          : null}
        {rows.length === 0 && (configLoading || loading.length > 0) ? (
          <p className="plugins-sidebar__empty" role="status">
            {t("common.loading")}…
          </p>
        ) : null}
        {rows.length === 0 && !configLoading && loading.length === 0 && ready && !configError ? (
          <p className="plugins-sidebar__empty">
            {t(
              search || tag
                ? "common.noResults"
                : scope === "installed"
                  ? "plugins.empty"
                  : scope === "updates"
                    ? "market.noUpdates"
                    : "plugins.marketplaceEmpty",
            )}
          </p>
        ) : null}
        {visibleRows.map(({ info, entry, source, installed }) => {
          const origin = scope === "installed" ? "local" : (source?.id ?? "local"),
            tabId = `extension:${origin}:${info.id}`;
          const own = !!installed && !!source && boundTo(installed, source);
          const update = !!entry && own && newerVersion(entry.version, installed!.version),
            busy = busyIds.includes(info.id) || !!tasks[info.id];
          return (
            <article
              className={`extension-row${active === tabId ? " is-active" : ""}`}
              key={`${origin}:${info.id}`}
            >
              <button
                type="button"
                className="extension-row__open"
                aria-current={active === tabId ? "page" : undefined}
                onClick={() => useWorkspace.getState().openPluginDetail(origin, info.id, info.name)}
                onDoubleClick={() => useWorkspace.getState().keepTab(tabId)}
              >
                {info.runtime === "theme" ? (
                  <Palette size={29} aria-hidden="true" />
                ) : (
                  <Package size={29} aria-hidden="true" />
                )}
                <span className="extension-row__body">
                  <strong title={info.name}>{info.name}</strong>
                  <span className="extension-row__description">{info.description}</span>
                  <small>
                    {info.author?.trim() || t("market.unknownAuthor")} · {info.version}
                  </small>
                  {info.runtime === "theme" ? (
                    <span className="extension-row__kind">{t("plugins.themePack")}</span>
                  ) : null}
                </span>
              </button>
              {pluginTags(info).length ? (
                <div className="extension-row__tags">
                  {pluginTags(info).map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-label={t("market.filterTag", { tag: value })}
                      aria-pressed={tag === value}
                      onClick={() => setTag(tag === value ? "" : value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="extension-row__footer">
                <span
                  className="extension-row__source"
                  title={source?.url ?? installed?.sourceUrl ?? installed?.path}
                >
                  {source?.name ?? installed?.sourceId ?? t("market.local")}
                </span>
                {entry && source && (!installed || update) ? (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || (entry.apiVersion != null && entry.apiVersion !== 1)}
                    onClick={() => requestMarketInstall(entry, source, update)}
                  >
                    {t(busy ? "plugins.installing" : update ? "market.update" : "plugins.install")}
                  </Button>
                ) : (
                  <span className="extension-row__state">
                    {t(installed ? "plugins.installedTab" : "market.sourceConflict")}
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </OverlayScrollArea>
      {rows.length > PLUGIN_PAGE_SIZE ? (
        <nav className="plugins-pagination" aria-label={t("market.pagination")}>
          <IconButton
            label={t("market.previousPage")}
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <span role="status">
            {t("market.pageInfo", { page: currentPage + 1, pages: pageCount, count: rows.length })}
          </span>
          <IconButton
            label={t("market.nextPage")}
            size="sm"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={14} />
          </IconButton>
        </nav>
      ) : null}
      <div className="plugins-browser__foot">
        <Button
          size="sm"
          variant="ghost"
          leading={<FolderOpen size={13} />}
          onClick={() => void api.pluginOpenDir().catch((e) => toast(translateError(e), "error"))}
        >
          {t("plugins.openFolder")}
        </Button>
      </div>
      <LocalPluginInstall request={installRequest} />
    </section>
  );
}
