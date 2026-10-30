// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FolderOpen, LayoutPanelLeft, Play, RefreshCw, Square } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Misc";
import { cn } from "@/lib/format";
import { api } from "@/lib/ipc";
import { usePlugins } from "@/store/plugins";
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
  const busy = usePlugins((state) => state.busy);
  const outputs = usePlugins((state) => state.outputs);
  const load = usePlugins((state) => state.load);
  const start = usePlugins((state) => state.start);
  const stop = usePlugins((state) => state.stop);
  const run = usePlugins((state) => state.run);
  const openPluginView = useWorkspace((state) => state.openPluginView);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="settings-section">
      <div className="settings-section__head">
        <h2 className="settings-section__title">{t("settings.plugins")}</h2>
        <div className="settings-actions settings-actions--inline">
          <Button
            variant="ghost"
            size="sm"
            leading={<RefreshCw size={13} />}
            onClick={() => void load()}
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
                  disabled={busy === plugin.id}
                  onClick={() => void (running ? stop(plugin.id) : start(plugin.id))}
                >
                  {running ? t("plugins.stop") : t("plugins.start")}
                </Button>
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
                      disabled={!running || busy === plugin.id}
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
    </section>
  );
}
