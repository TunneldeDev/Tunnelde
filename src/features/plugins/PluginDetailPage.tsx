import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Package, Palette, Play, Square, Trash2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { useMarketplace, boundTo, newerVersion } from "@/store/marketplace";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import { useWorkspace } from "@/store/workspace";
import type { MarketEntry, MarketSource, PluginView } from "@/lib/api/types";
import { useNavigation } from "@/store/navigation";
import { pluginSidebarId } from "@/lib/plugins/sidebars";
import i18n from "@/i18n/i18n";
import { PluginError } from "./PluginError";
import { PluginThemes } from "./PluginThemes";
import { PluginFileIconThemes } from "./PluginFileIconThemes";
import { PluginMarkdown } from "./PluginMarkdown";
import { PluginRestrictedAction } from "./PluginSecuritySection";
import { PluginCommandResult } from "./PluginCommandResult";
import { pluginTags, togglePluginTag } from "@/lib/plugins/discovery";
import { openPluginAction } from "@/lib/plugins/actions";
import { supportsManifestVersion } from "@/lib/plugins/activation/compatibility";

export function requestMarketInstall(entry: MarketEntry, source: MarketSource, update: boolean) {
  const t = i18n.t.bind(i18n);
  useDialogs.getState().confirm({
    title: t(update ? "market.update" : "market.installConfirm", { name: entry.name }),
    body: t(
      entry.runtime === "theme"
        ? update
          ? "market.themeUpdateBody"
          : "market.themeInstallBody"
        : update
          ? "market.updateBody"
          : "market.installBody",
      {
        name: entry.name,
        version: entry.version,
        source: `${source.name}\n${source.url}`,
        runtime: entry.runtime ?? "node",
      },
    ),
    confirmLabel: t(update ? "market.update" : "plugins.install"),
    onConfirm: () => {
      void useMarketplace.getState().install(entry, source, update);
    },
  });
}

export function PluginDetailPage({ sourceId, pluginId }: { sourceId: string; pluginId: string }) {
  const { t } = useTranslation();
  const { catalogues, config, loading, tasks, cancelling, taskErrors, load, cancel } =
    useMarketplace();
  const items = usePlugins((s) => s.items),
    busy = usePlugins((s) => s.busyIds.includes(pluginId));
  const commanding = usePlugins((s) => s.commandingIds.includes(pluginId));
  const starting = usePlugins((s) => s.startingIds.includes(pluginId));
  const output = usePlugins((s) => s.outputs[pluginId]);
  const loadPlugins = usePlugins((s) => s.load);
  useEffect(() => {
    void load();
    void loadPlugins();
  }, [load, loadPlugins]);
  const installed = items.find((p) => p.id === pluginId);
  const source =
    sourceId === "local" && installed
      ? config.sources.find((candidate) => boundTo(installed, candidate))
      : config.sources.find((candidate) => candidate.id === sourceId);
  const catalogue =
    source && catalogues[source.id]?.source.url === source.url ? catalogues[source.id] : undefined;
  const entry = catalogue?.entries.find((e) => e.id === pluginId);
  const own = installed && (sourceId === "local" || (!!source && boundTo(installed, source)));
  const info = sourceId === "local" ? installed : (entry ?? (own ? installed : null));
  const canUpdate =
    !!entry && !!installed && !!own && newerVersion(entry.version, installed.version);
  const running = own && installed.status === "running";
  const themeOnly = (own ? installed : info)?.runtime === "theme";
  const task = tasks[pluginId];
  const progress =
    task?.total && task.total > 0
      ? Math.min(100, Math.max(0, (task.received / task.total) * 100))
      : undefined;
  if (!info)
    return (
      <div className="page plugin-detail">
        <EmptyState title={t(loading.length ? "common.loading" : "market.notFound")} />
      </div>
    );
  const openView = async (view: PluginView) => {
    if (!installed) return;
    if (usePlugins.getState().items.find((p) => p.id === pluginId)?.status !== "running")
      await usePlugins.getState().start(pluginId);
    if (usePlugins.getState().items.find((p) => p.id === pluginId)?.status === "running") {
      if (view.location === "sidebar")
        useNavigation.getState().showSidebar(pluginSidebarId(pluginId, view.id));
      else useWorkspace.getState().openPluginView(pluginId, view.id, view.title);
    }
  };
  const compatible = supportsManifestVersion(entry?.apiVersion);
  return (
    <div className="page plugin-detail">
      <header className="plugin-detail__head">
        <div className="plugin-detail__icon">
          {themeOnly ? <Palette size={36} /> : <Package size={36} />}
        </div>
        <div className="plugin-detail__identity">
          <h1>{info.name}</h1>
          <p>
            {info.author?.trim() || t("market.unknownAuthor")}
            <span> · {info.version}</span>
          </p>
          <p>{info.description}</p>
          {pluginTags(info).length ? (
            <div className="extension-row__tags">
              {pluginTags(info).map((tag) => (
                <button
                  type="button"
                  key={tag}
                  onClick={() => {
                    const market = useMarketplace.getState();
                    market.setTag("");
                    market.setQuery(togglePluginTag(market.query, tag));
                    useNavigation.getState().showSidebar("plugins");
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>
      <div className="plugin-detail__actions">
        {!installed && entry && source ? (
          <Button
            variant="primary"
            disabled={busy || !!task || !source.enabled || !compatible}
            onClick={() => requestMarketInstall(entry, source, false)}
          >
            {t("plugins.install")}
          </Button>
        ) : null}
        {installed && !own ? (
          <p className="settings-message">{t("market.sourceConflict")}</p>
        ) : null}
        {canUpdate && entry && source ? (
          <Button
            variant="primary"
            disabled={busy || !!task || !source.enabled || !compatible}
            onClick={() => requestMarketInstall(entry, source, true)}
          >
            {t("market.update")} {entry.version}
          </Button>
        ) : null}
        {own ? (
          <>
            {!themeOnly ? (
              <Button
                disabled={(busy && !starting && !commanding) || !!task}
                leading={running || starting ? <Square size={13} /> : <Play size={13} />}
                onClick={() =>
                  void (running || starting
                    ? usePlugins.getState().stop(pluginId)
                    : usePlugins.getState().start(pluginId))
                }
              >
                {t(starting ? "common.cancel" : running ? "plugins.stop" : "plugins.start")}
              </Button>
            ) : null}
            <Button
              disabled={busy || !!task}
              leading={<Trash2 size={13} />}
              onClick={() =>
                useDialogs.getState().confirm({
                  title: t("plugins.uninstallTitle"),
                  body: t("plugins.uninstallBody", { name: info.name }),
                  confirmLabel: t("plugins.uninstall"),
                  danger: true,
                  onConfirm: () => usePlugins.getState().uninstall(pluginId),
                })
              }
            >
              {t("plugins.uninstall")}
            </Button>
            {!themeOnly ? (
              <span className="plugin-detail__status" role="status" aria-live="polite">
                <StatusDot
                  tone={
                    starting
                      ? "idle"
                      : running
                        ? "ok"
                        : installed.status === "failed"
                          ? "error"
                          : "idle"
                  }
                />
                {t(
                  starting
                    ? "plugins.starting"
                    : running
                      ? "plugins.running"
                      : installed.status === "failed"
                        ? "plugins.failed"
                        : "plugins.stopped",
                )}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {!compatible ? <p className="panel__error">{t("market.incompatibleApi")}</p> : null}
      {task ? (
        <div className="plugin-download" role="status">
          <span>
            {t(
              `market.phase.${task.phase in phases ? (task.phase as keyof typeof phases) : "connecting"}`,
            )}{" "}
            {progress !== undefined ? `${Math.round(progress)}%` : ""}
          </span>
          <progress aria-label={t("plugins.installing")} max={100} value={progress} />
          <Button
            size="sm"
            disabled={cancelling.includes(pluginId)}
            onClick={() => void cancel(pluginId)}
          >
            {t(cancelling.includes(pluginId) ? "plugins.node.cancelling" : "market.cancel")}
          </Button>
        </div>
      ) : null}
      {taskErrors[pluginId] ? <PluginError message={taskErrors[pluginId]} /> : null}
      {own && installed.error ? (
        <div>
          <p className="panel__error" role="alert">
            {installed.error}
          </p>
          <PluginRestrictedAction />
        </div>
      ) : null}
      <dl className="plugin-detail__metadata">
        <div>
          <dt>{t("market.source")}</dt>
          <dd>
            {source?.name ??
              (sourceId === "local" ? installed?.sourceId : null) ??
              t("market.local")}
            <small>{source?.url ?? installed?.sourceUrl ?? installed?.path}</small>
          </dd>
        </div>
        <div>
          <dt>{t("market.runtime")}</dt>
          <dd>
            {themeOnly
              ? t("plugins.themeNoRuntime")
              : info.runtime === "declarative"
                ? t("market.declarativeRuntime")
                : (info.runtime ?? "node")}
            {!themeOnly && info.engines?.node ? ` ${info.engines.node}` : ""}
          </dd>
        </div>
        {info.engines?.tunnelde ? (
          <div>
            <dt>{t("market.tunneldeVersion")}</dt>
            <dd>{info.engines.tunnelde}</dd>
          </div>
        ) : null}
        {info.apiVersion != null ? (
          <div>
            <dt>{t("market.apiVersion")}</dt>
            <dd>{info.apiVersion}</dd>
          </div>
        ) : null}
        {info.dependencies?.length ? (
          <div>
            <dt>{t("plugins.requiredDependencies")}</dt>
            <dd>
              {info.dependencies.map((dependency) => (
                <div key={dependency.id}>
                  {dependency.id} · {dependency.version}
                </div>
              ))}
            </dd>
          </div>
        ) : null}
        {own ? (
          <div>
            <dt>{t("market.installedVersion")}</dt>
            <dd>{installed.version}</dd>
          </div>
        ) : null}
      </dl>
      {own && installed.themes?.length ? (
        <PluginThemes themes={installed.themes} disabled={busy || !!task} />
      ) : null}
      {own && installed.fileIconThemes?.length ? (
        <PluginFileIconThemes plugin={installed} disabled={busy || !!task} />
      ) : null}
      {own && installed.filePreviews?.length ? (
        <section className="plugin-detail__themes" aria-label={t("preview.providers")}>
          <h2>{t("preview.providers")}</h2>
          <p className="settings-hint">{t("preview.providerHint")}</p>
          <div className="plugin-theme-list">
            {installed.filePreviews.map((provider) => (
              <article className="plugin-theme" key={provider.id}>
                <h3>{provider.name}</h3>
                <p className="settings-hint">
                  {provider.extensions.map((extension) => `.${extension}`).join(" · ")}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {own && !themeOnly && installed.views.some((view) => !view.provider) ? (
        <section className="plugin-detail__tools">
          <h2>{t("market.openTool")}</h2>
          <div className="settings-actions">
            {installed.views
              .filter((view) => !view.provider)
              .map((view) => (
                <Button
                  key={view.id}
                  variant="primary"
                  disabled={busy || !!task}
                  leading={<ExternalLink size={13} />}
                  onClick={() => void openView(view)}
                >
                  {view.title}
                </Button>
              ))}
          </div>
        </section>
      ) : null}
      {own && !themeOnly && installed.commands.length ? (
        <div className="settings-actions">
          {installed.commands.map((command) => (
            <Button
              key={command.id}
              disabled={!running || busy}
              onClick={() =>
                void (command.hostMenu
                  ? openPluginAction({ id: pluginId, command: command.id })
                  : usePlugins.getState().run(pluginId, command.id))
              }
            >
              {command.title}
            </Button>
          ))}
        </div>
      ) : null}
      {output && own ? (
        <PluginCommandResult
          result={output}
          onClear={() => usePlugins.getState().clearOutput(pluginId)}
        />
      ) : null}
      {output?.error && own ? <PluginRestrictedAction /> : null}
      <section className="plugin-detail__readme">
        <h2>{t("market.description")}</h2>
        <PluginMarkdown source={info.readme ?? info.description ?? ""} />
      </section>
    </div>
  );
}
const phases = {
  connecting: true,
  downloading: true,
  downloaded: true,
  verifying: true,
  installing: true,
  done: true,
};
