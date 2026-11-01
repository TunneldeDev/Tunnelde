// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ChevronRight,
  FolderOpen,
  LayoutPanelLeft,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { StatusDot } from "@/components/ui/display/Misc";
import { translateError } from "@/lib/api/errors";
import { cn } from "@/lib/text/format";
import { api, isTauri } from "@/lib/api/ipc";
import type { MarketEntry } from "@/lib/api/types";
import { fetchMarketplace, installMarketplaceEntry } from "@/lib/plugins/marketplace";
import { useDialogs } from "@/store/dialogs";
import { usePlugins } from "@/store/plugins";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";

const STATUS_TONE = { running: "ok", stopped: "idle", failed: "error" } as const;

const STATUS_LABEL = {
  running: "plugins.running",
  stopped: "plugins.stopped",
  failed: "plugins.failed",
} as const;

export function PluginsSection({ sidebar = false }: { sidebar?: boolean }) {
  const { t } = useTranslation();
  const items = usePlugins((state) => state.items);
  const busyIds = usePlugins((state) => state.busyIds);
  const reloading = usePlugins((state) => state.reloading);
  const outputs = usePlugins((state) => state.outputs);
  const load = usePlugins((state) => state.load);
  const start = usePlugins((state) => state.start);
  const stop = usePlugins((state) => state.stop);
  const run = usePlugins((state) => state.run);
  const reload = usePlugins((state) => state.reload);
  const install = usePlugins((state) => state.install);
  const apply = usePlugins((state) => state.apply);
  const confirm = useDialogs((state) => state.confirm);
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.pluginInspect>> | null>(
    null,
  );
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectEpoch, setInspectEpoch] = useState(0);
  const [localInstalling, setLocalInstalling] = useState(false);
  const localInstallLock = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const [market, setMarket] = useState<MarketEntry[] | null>(null);
  const [marketError, setMarketError] = useState(false);
  const [installing, setInstalling] = useState<string[]>([]);
  const marketInstallLocks = useRef(new Set<string>());
  const openPluginView = useWorkspace((state) => state.openPluginView);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"installed" | "market">("installed");
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [marketEpoch, setMarketEpoch] = useState(0);
  const tabsId = useId();
  const search = query.trim().toLocaleLowerCase();
  const matches = (entry: { id: string; name: string; description?: string | null }) =>
    !search ||
    `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLocaleLowerCase().includes(search);
  const visibleItems = sidebar ? items.filter(matches) : items;
  const visibleMarket = sidebar ? (market ?? []).filter(matches) : (market ?? []);
  const choosePath = (value: string | null) => {
    setPreview(null);
    setInspectError(null);
    setPath(value);
    setInspectEpoch((current) => current + 1);
  };
  const refreshMarket = () => {
    setMarketError(false);
    setMarketEpoch((value) => value + 1);
  };

  useEffect(() => {
    let alive = true;
    void load().finally(() => {
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(() => {
    let alive = true;
    fetchMarketplace()
      .then((entries) => {
        if (alive) {
          setMarket(entries);
        }
      })
      .catch(() => {
        if (alive) {
          setMarketError(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [marketEpoch]);

  const installFromMarket = async (entry: MarketEntry) => {
    if (marketInstallLocks.current.has(entry.id)) return;
    marketInstallLocks.current.add(entry.id);
    setInstalling([...marketInstallLocks.current]);
    try {
      apply(await installMarketplaceEntry(entry));
      await load();
      toast(t("plugins.installed"), "success");
    } catch (error) {
      toast(translateError(error), "error");
    } finally {
      marketInstallLocks.current.delete(entry.id);
      setInstalling([...marketInstallLocks.current]);
    }
  };

  useEffect(() => {
    let alive = true;
    if (path) {
      void api
        .pluginInspect(path)
        .then((value) => {
          if (alive) setPreview(value);
        })
        .catch((cause: unknown) => {
          if (alive) setInspectError(translateError(cause));
        });
    }
    return () => {
      alive = false;
    };
  }, [path, inspectEpoch]);

  const pickLocal = async (archive: boolean) => {
    try {
      const picked = await (archive ? api.pluginPickArchive() : api.pluginPickFolder());
      if (picked) choosePath(picked);
    } catch (cause) {
      toast(translateError(cause), "error");
    }
  };

  const installLocal = async () => {
    if (!path || !preview || localInstallLock.current) return;
    localInstallLock.current = true;
    setLocalInstalling(true);
    try {
      if (await install(path)) {
        choosePath(null);
        toast(t("plugins.installed"), "success");
      }
    } finally {
      localInstallLock.current = false;
      setLocalInstalling(false);
    }
  };

  // Only the visible plugin surface accepts a native package drop.
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let alive = true;
    let unlisten: UnlistenFn | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          if (
            localInstallLock.current ||
            !sectionRef.current ||
            sectionRef.current.closest("[hidden]")
          )
            return;
          const { x, y } = event.payload.position;
          const hit = document.elementFromPoint(
            x / window.devicePixelRatio,
            y / window.devicePixelRatio,
          );
          if (!hit?.closest(".plugins-section, .plugins-sidebar, .plugin-install-dialog")) return;
          const first = event.payload.paths[0];
          if (first) {
            choosePath(first);
          }
        }
      })
      .then((fn) => {
        if (alive) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const uninstall = (plugin: (typeof items)[number]) => {
    confirm({
      title: t("plugins.uninstallTitle"),
      body: t("plugins.uninstallBody", { name: plugin.name }),
      confirmLabel: t("plugins.uninstall"),
      danger: true,
      onConfirm: async () => {
        try {
          await api.pluginUninstall(plugin.id);
          await load();
        } catch (error) {
          toast(translateError(error), "error");
        }
      },
    });
  };

  return (
    <section
      className={sidebar ? "plugins-sidebar" : "settings-section plugins-section"}
      ref={sectionRef}
      aria-label={t("settings.plugins")}
    >
      {sidebar ? (
        <>
          <header className="sidebar__head plugins-sidebar__head">
            <h2 className="sidebar__title">{t("settings.plugins")}</h2>
            <IconButton label={t("plugins.installTitle")} size="sm" onClick={() => choosePath("")}>
              <Plus size={14} />
            </IconButton>
            <IconButton
              label={t("plugins.reload")}
              size="sm"
              disabled={reloading}
              onClick={() => {
                void reload();
                refreshMarket();
              }}
            >
              <RefreshCw size={13} />
            </IconButton>
            <IconButton
              label={t("plugins.openFolder")}
              size="sm"
              onClick={() =>
                void api.pluginOpenDir().catch((error) => toast(translateError(error), "error"))
              }
            >
              <FolderOpen size={14} />
            </IconButton>
          </header>
          <div className="sidebar__search">
            <div className="sidebar__filter">
              <Search size={13} aria-hidden="true" />
              <Input
                aria-label={t("plugins.search")}
                placeholder={t("plugins.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div
            className="plugins-sidebar__tabs"
            role="tablist"
            aria-label={t("settings.plugins")}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "installed"
                  : event.key === "End"
                    ? "market"
                    : scope === "installed"
                      ? "market"
                      : "installed";
              setScope(next);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)
                ?.focus();
            }}
          >
            <button
              id={`${tabsId}-installed`}
              type="button"
              role="tab"
              data-scope="installed"
              aria-selected={scope === "installed"}
              aria-controls={`${tabsId}-installed-panel`}
              tabIndex={scope === "installed" ? 0 : -1}
              onClick={() => setScope("installed")}
            >
              {t("plugins.installedTab")}
              <span>{items.length}</span>
            </button>
            <button
              id={`${tabsId}-market`}
              type="button"
              role="tab"
              data-scope="market"
              aria-selected={scope === "market"}
              aria-controls={`${tabsId}-market-panel`}
              tabIndex={scope === "market" ? 0 : -1}
              onClick={() => setScope("market")}
            >
              {t("plugins.marketplace")}
            </button>
          </div>
        </>
      ) : (
        <div className="settings-section__head">
          <h2 className="settings-section__title">{t("settings.plugins")}</h2>
          <div className="settings-actions settings-actions--inline">
            <Button
              variant="primary"
              size="sm"
              leading={<Plus size={13} />}
              onClick={() => choosePath("")}
            >
              {t("plugins.install")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leading={<RefreshCw size={13} />}
              disabled={reloading}
              onClick={() => void reload()}
            >
              {t("plugins.reload")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leading={<FolderOpen size={13} />}
              onClick={() => void api.pluginOpenDir().catch(() => undefined)}
            >
              {t("plugins.openFolder")}
            </Button>
          </div>
        </div>
      )}

      {!sidebar || scope === "installed" ? (
        <div
          className="plugin-list"
          role={sidebar ? "tabpanel" : undefined}
          id={`${tabsId}-installed-panel`}
          aria-labelledby={sidebar ? `${tabsId}-installed` : undefined}
          aria-label={sidebar ? undefined : t("plugins.installedTab")}
          aria-busy={!loaded || reloading}
        >
          {sidebar && !loaded ? (
            <p className="plugins-sidebar__empty" role="status">
              {t("common.loading")}…
            </p>
          ) : null}
          {loaded && visibleItems.length === 0 ? (
            <p className={sidebar ? "plugins-sidebar__empty" : "plugin-empty"}>
              {t(search ? "common.noResults" : "plugins.empty")}
            </p>
          ) : null}

          {visibleItems.map((plugin) => {
            const output = outputs[plugin.id];
            const running = plugin.status === "running";
            const busy = busyIds.includes(plugin.id);
            if (sidebar)
              return (
                <article className="plugins-sidebar__plugin" key={plugin.id}>
                  <button
                    type="button"
                    className="plugins-sidebar__plugin-row"
                    aria-expanded={selected === plugin.id}
                    onClick={() => setSelected(selected === plugin.id ? null : plugin.id)}
                  >
                    <Package size={23} className="plugins-sidebar__package" aria-hidden="true" />
                    <span className="plugins-sidebar__identity">
                      <strong title={plugin.name}>{plugin.name}</strong>
                      <span>
                        {plugin.version}
                        <span className="plugins-sidebar__status">
                          <StatusDot tone={STATUS_TONE[plugin.status]} />
                          {t(STATUS_LABEL[plugin.status])}
                        </span>
                      </span>
                    </span>
                    <ChevronRight
                      size={13}
                      className={selected === plugin.id ? "is-open" : undefined}
                      aria-hidden="true"
                    />
                  </button>
                  {selected === plugin.id ? (
                    <div className="plugins-sidebar__details">
                      {plugin.description ? (
                        <p className="plugins-sidebar__description">{plugin.description}</p>
                      ) : null}
                      {plugin.error ? (
                        <p className="plugin-card__error" role="alert">
                          {plugin.error}
                        </p>
                      ) : null}
                      <div className="plugins-sidebar__actions">
                        <Button
                          size="sm"
                          variant={running ? "secondary" : "primary"}
                          leading={running ? <Square size={11} /> : <Play size={11} />}
                          disabled={busy}
                          onClick={() => void (running ? stop(plugin.id) : start(plugin.id))}
                        >
                          {t(running ? "plugins.stop" : "plugins.start")}
                        </Button>
                        <IconButton
                          label={t("plugins.uninstall")}
                          size="sm"
                          disabled={busy}
                          danger
                          onClick={() => uninstall(plugin)}
                        >
                          <Trash2 size={12} />
                        </IconButton>
                      </div>
                      {plugin.views.map((view) => (
                        <Button
                          key={view.id}
                          variant="ghost"
                          size="sm"
                          leading={<LayoutPanelLeft size={12} />}
                          disabled={!running || busy}
                          onClick={() => openPluginView(plugin.id, view.id, view.title)}
                        >
                          {view.title}
                        </Button>
                      ))}
                      {plugin.commands.map((command) => (
                        <Button
                          key={command.id}
                          variant="ghost"
                          size="sm"
                          disabled={!running || busy}
                          onClick={() => void run(plugin.id, command.id)}
                        >
                          {command.title}
                        </Button>
                      ))}
                      {plugin.permissions.length ? (
                        <p className="plugins-sidebar__permissions">
                          {t("plugins.permissions")}: {plugin.permissions.join(" · ")}
                        </p>
                      ) : null}
                      {output ? (
                        <pre className={cn("plugin-output", output.error && "is-error")}>
                          {output.text}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            return (
              <article className="plugin-card" key={plugin.id}>
                <header className="plugin-card__head">
                  <StatusDot tone={STATUS_TONE[plugin.status]} />
                  <span className="plugin-card__name">{plugin.name}</span>
                  <span className="plugin-card__version">{plugin.version}</span>
                  <span className="plugin-card__status">{t(STATUS_LABEL[plugin.status])}</span>
                  <Button
                    variant={running ? "secondary" : "primary"}
                    size="sm"
                    leading={running ? <Square size={11} /> : <Play size={11} />}
                    disabled={busyIds.includes(plugin.id)}
                    onClick={() => void (running ? stop(plugin.id) : start(plugin.id))}
                  >
                    {running ? t("plugins.stop") : t("plugins.start")}
                  </Button>
                  <IconButton
                    label={t("plugins.uninstall")}
                    size="sm"
                    danger
                    disabled={busyIds.includes(plugin.id)}
                    onClick={() => uninstall(plugin)}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </header>

                {plugin.description ? (
                  <p className="plugin-card__desc">{plugin.description}</p>
                ) : null}
                {plugin.error ? <p className="plugin-card__error">{plugin.error}</p> : null}

                {plugin.commands.length > 0 ||
                plugin.views.length > 0 ||
                plugin.permissions.length > 0 ? (
                  <div className="plugin-card__row">
                    {plugin.views.map((view) => (
                      <Button
                        key={view.id}
                        variant="ghost"
                        size="sm"
                        leading={<LayoutPanelLeft size={12} />}
                        disabled={!running}
                        onClick={() => openPluginView(plugin.id, view.id, view.title)}
                      >
                        {view.title}
                      </Button>
                    ))}
                    {plugin.commands.map((command) => (
                      <Button
                        key={command.id}
                        variant="ghost"
                        size="sm"
                        disabled={!running || busyIds.includes(plugin.id)}
                        onClick={() => void run(plugin.id, command.id)}
                      >
                        {command.title}
                      </Button>
                    ))}
                    {plugin.permissions.length > 0 ? (
                      <span className="plugin-card__permissions">
                        {plugin.permissions.join(" · ")}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {output ? (
                  <pre className={cn("plugin-output", output.error && "is-error")}>
                    {output.text}
                  </pre>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {path !== null ? (
        <Dialog
          open
          title={t("plugins.installTitle")}
          closeLabel={t("common.cancel")}
          onClose={() => choosePath(null)}
          width={480}
          className="plugin-install-dialog"
          dismissible={!localInstalling}
          footer={
            <>
              <Button variant="ghost" disabled={localInstalling} onClick={() => choosePath(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={!preview || localInstalling}
                onClick={() => void installLocal()}
              >
                {t(localInstalling ? "plugins.installing" : "plugins.install")}
              </Button>
            </>
          }
        >
          <div className="plugin-install-zone" aria-busy={localInstalling}>
            <FolderOpen size={28} aria-hidden="true" />
            <p>{t("plugins.dropHint")}</p>
            <div className="settings-actions">
              <Button
                variant="primary"
                disabled={localInstalling}
                onClick={() => void pickLocal(true)}
              >
                {t("plugins.browseArchive")}
              </Button>
              <Button
                variant="secondary"
                disabled={localInstalling}
                onClick={() => void pickLocal(false)}
              >
                {t("plugins.browseFolder")}
              </Button>
            </div>
          </div>
          {path ? (
            <p className="plugin-install-path" title={path}>
              {path}
            </p>
          ) : null}
          {path && !preview && !inspectError ? (
            <p role="status">{t("plugins.inspecting")}</p>
          ) : null}
          {inspectError ? (
            <p className="panel__error" role="alert">
              {inspectError}
            </p>
          ) : null}
          {preview ? (
            <div className="plugin-install-preview">
              <strong>{preview.name}</strong> <span>{preview.version}</span>
              <p>
                {t("plugins.permissions")}:{" "}
                {preview.permissions.join(" · ") || t("plugins.noPermissions")}
              </p>
            </div>
          ) : null}
        </Dialog>
      ) : null}

      {!sidebar || scope === "market" ? (
        <div
          className={sidebar ? "plugins-sidebar__market" : "settings-subsection"}
          role={sidebar ? "tabpanel" : undefined}
          id={`${tabsId}-market-panel`}
          aria-labelledby={sidebar ? `${tabsId}-market` : undefined}
          aria-label={sidebar ? undefined : t("plugins.marketplace")}
        >
          {!sidebar ? <h3 className="settings-subtitle">{t("plugins.marketplace")}</h3> : null}
          {sidebar && !market && !marketError ? (
            <p className="plugins-sidebar__empty" role="status">
              {t("common.loading")}…
            </p>
          ) : null}
          {marketError ? (
            <div className={sidebar ? "plugins-sidebar__empty" : "settings-hint"}>
              <p>{t("plugins.marketplaceUnavailable")}</p>
              <Button size="sm" variant="ghost" onClick={refreshMarket}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
          {market && market.length === 0 && !marketError ? (
            <p className={sidebar ? "plugins-sidebar__empty" : "settings-hint"}>
              {t("plugins.marketplaceEmpty")}
            </p>
          ) : null}
          {market && market.length > 0 && visibleMarket.length === 0 ? (
            <p className="plugins-sidebar__empty">{t("common.noResults")}</p>
          ) : null}
          {!marketError &&
            visibleMarket.map((entry) => (
              <div className="market-row" key={entry.id}>
                <span className="market-row__name">{entry.name}</span>
                <span className="market-row__version">{entry.version}</span>
                <span className="market-row__desc">{entry.description ?? ""}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={
                    installing.includes(entry.id) || items.some((item) => item.id === entry.id)
                  }
                  onClick={() => void installFromMarket(entry)}
                >
                  {t(
                    items.some((item) => item.id === entry.id)
                      ? "plugins.installedTab"
                      : installing.includes(entry.id)
                        ? "plugins.installing"
                        : "plugins.install",
                  )}
                </Button>
              </div>
            ))}
        </div>
      ) : null}
    </section>
  );
}
