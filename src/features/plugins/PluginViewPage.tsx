// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { normalizeBlocks, viewTitle, type PluginBlock } from "@/lib/plugins/pluginView";

interface PluginViewPageProps {
  pluginId: string;
  viewId: string;
}

interface RenderedView {
  title: string;
  blocks: PluginBlock[];
}

export function PluginViewPage({ pluginId, viewId }: PluginViewPageProps) {
  return (
    <PluginViewContent
      key={JSON.stringify([pluginId, viewId])}
      pluginId={pluginId}
      viewId={viewId}
    />
  );
}

function PluginViewContent({ pluginId, viewId }: PluginViewPageProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<RenderedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const current = ++requestId.current;
    return api
      .pluginRenderView(pluginId, viewId)
      .then((payload) => {
        if (current !== requestId.current) return;
        const record = (payload ?? {}) as Record<string, unknown>;
        setView({ title: viewTitle(payload), blocks: normalizeBlocks(record.blocks) });
        setError(null);
      })
      .catch((cause: unknown) => {
        if (current === requestId.current) setError(translateError(cause));
      })
      .finally(() => {
        if (current === requestId.current) setLoading(false);
      });
  }, [pluginId, viewId]);

  const invalidate = useCallback(() => {
    ++requestId.current;
  }, []);

  useEffect(() => {
    void load();
    return invalidate;
  }, [invalidate, load]);

  return (
    <div className="plugin-view">
      <header className="plugin-view__head">
        <span className="plugin-view__title">{view?.title || t("pluginView.title")}</span>
        <span className="plugin-view__plugin">{pluginId}</span>
        <Button
          variant="ghost"
          size="sm"
          leading={<RefreshCw size={13} />}
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            void load();
          }}
        >
          {t("pluginView.refresh")}
        </Button>
      </header>

      {error ? <p className="panel__error">{error}</p> : null}

      <div className="plugin-view__body" aria-busy={loading}>
        {view === null ? (
          loading ? (
            <p role="status">{t("common.loading")}</p>
          ) : null
        ) : view.blocks.length === 0 ? (
          <EmptyState title={t("pluginView.empty")} />
        ) : (
          view.blocks.map((block, index) => {
            if (block.type === "heading") {
              return (
                <h2 className="plugin-block__heading" key={index}>
                  {block.text}
                </h2>
              );
            }
            if (block.type === "text") {
              return (
                <p className="plugin-block__text" key={index}>
                  {block.text}
                </p>
              );
            }
            if (block.type === "kv") {
              return (
                <dl className="plugin-kv" key={index}>
                  {block.items.map((item, itemIndex) => (
                    <div className="plugin-kv__row" key={itemIndex}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              );
            }
            return (
              <table className="plugin-table" key={index}>
                <thead>
                  <tr>
                    {block.columns.map((column, columnIndex) => (
                      <th key={columnIndex}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })
        )}
      </div>
    </div>
  );
}
