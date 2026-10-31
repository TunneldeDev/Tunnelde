// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FolderOpen, LayoutPanelLeft, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { Button, IconButton } from "@/components/ui/form/Button";
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

export function PluginsSection() {
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
  const confirm = useDialogs((state) => state.confirm);
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.pluginInspect>> | null>(
    null,
  );
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [localInstalling, setLocalInstalling] = useState(false);
  const localInstallLock = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const [market, setMarket] = useState<MarketEntry[] | null>(null);
  const [marketError, setMarketError] = useState(false);
  const [installing, setInstalling] = useState<string[]>([]);
  const marketInstallLocks = useRef(new Set<string>());
  const openPluginView = useWorkspace((state) => state.openPluginView);
  const choosePath = (value: string | null) => {
    setPreview(null);
    setInspectError(null);
    setPath(value);
  };

  useEffect(() => {
    void load();
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
  }, []);

  const installFromMarket = async (entry: MarketEntry) => {
    if (marketInstallLocks.current.has(entry.id)) return;
    marketInstallLocks.current.add(entry.id);
    setInstalling([...marketInstallLocks.current]);
    try {
      await installMarketplaceEntry(entry);
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
  }, [path]);

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
          if (!hit?.closest(".plugins-section, .plugin-install-dialog")) return;
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
    <section className="settings-section plugins-section" ref={sectionRef}>
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

      <div className="plugin-list">
        {items.length === 0 ? <p className="plugin-empty">{t("plugins.empty")}</p> : null}

        {items.map((plugin) => {
          const output = outputs[plugin.id];
          const running = plugin.status === "running";
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

              {plugin.commands.length > 0 || plugin.permissions.length > 0 ? (
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
                <pre className={cn("plugin-output", output.error && "is-error")}>{output.text}</pre>
              ) : null}
            </article>
          );
        })}
      </div>

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

      <div className="settings-subsection">
        <h3 className="settings-subtitle">{t("plugins.marketplace")}</h3>
        {marketError ? (
          <p className="settings-hint">{t("plugins.marketplaceUnavailable")}</p>
        ) : null}
        {market && market.length === 0 && !marketError ? (
          <p className="settings-hint">{t("plugins.marketplaceEmpty")}</p>
        ) : null}
        {(market ?? []).map((entry) => (
          <div className="market-row" key={entry.id}>
            <span className="market-row__name">{entry.name}</span>
            <span className="market-row__version">{entry.version}</span>
            <span className="market-row__desc">{entry.description ?? ""}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={installing.includes(entry.id)}
              onClick={() => void installFromMarket(entry)}
            >
              {t("plugins.install")}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
