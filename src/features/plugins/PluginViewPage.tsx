import { Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { Field, Input, Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { translateError } from "@/lib/api/errors";
import { api, isTauri } from "@/lib/api/ipc";
import {
  normalizeBlocks,
  normalizeResult,
  PLUGIN_INPUT_MAX_BYTES,
  viewTitle,
  type PluginBlock,
  type PluginFormBlock,
} from "@/lib/plugins/pluginView";
import { copyText } from "@/lib/session/clipboard";
import { authorizePluginAction, reportPluginExecutionFailure } from "@/store/pluginSecurity";
import { PluginRestrictedAction } from "./PluginSecuritySection";
import { PluginChat } from "./PluginChat";
import { PluginMounts } from "./PluginMounts";
import "@/styles/pluginTools.css";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import { usePlugins } from "@/store/plugins";
import { PluginComponentView } from "./PluginComponentView";

interface PluginViewPageProps {
  pluginId: string;
  viewId: string;
  embedded?: boolean;
  visible?: boolean;
}

interface RenderedView {
  title: string;
  blocks: PluginBlock[];
}

export function PluginViewPage({
  pluginId,
  viewId,
  embedded,
  visible = true,
}: PluginViewPageProps) {
  const component = usePlugins((state) =>
    state.items.find(
      (plugin) =>
        plugin.id === pluginId &&
        plugin.views.some((view) => view.id === viewId && view.kind === "component"),
    ),
  );
  if (component)
    return (
      <PluginComponentView
        key={`${pluginId}:${viewId}:${component.fingerprint ?? ""}`}
        pluginId={pluginId}
        viewId={viewId}
        visible={visible}
      />
    );
  return (
    <PluginViewContent
      key={JSON.stringify([pluginId, viewId])}
      pluginId={pluginId}
      viewId={viewId}
      embedded={embedded}
      visible={visible}
    />
  );
}

function PluginViewContent({ pluginId, viewId, embedded, visible }: PluginViewPageProps) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<RenderedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const load = useCallback(
    (interactive = false) => {
      const current = ++requestId.current;
      const render = () =>
        api.pluginRenderView(pluginId, viewId, i18n.resolvedLanguage ?? i18n.language);
      return (
        interactive && isTauri()
          ? authorizePluginAction(pluginId).then((allowed) =>
              allowed && current === requestId.current ? render() : null,
            )
          : render()
      )
        .then((payload) => {
          if (current !== requestId.current) return;
          if (payload === null) return;
          const record = (payload ?? {}) as Record<string, unknown>;
          setView({ title: viewTitle(payload), blocks: normalizeBlocks(record.blocks) });
          setError(null);
        })
        .catch((cause: unknown) => {
          reportPluginExecutionFailure(cause);
          if (current === requestId.current) setError(translateError(cause));
        })
        .finally(() => {
          if (current === requestId.current) setLoading(false);
        });
    },
    [pluginId, viewId, i18n.resolvedLanguage, i18n.language],
  );

  const invalidate = useCallback(() => {
    ++requestId.current;
  }, []);

  useEffect(() => {
    void load();
    return invalidate;
  }, [invalidate, load]);

  const chatOnly = !!view?.blocks.length && view.blocks.every((block) => block.type === "chat");

  return (
    <div
      className={`plugin-view${embedded ? " plugin-view--sidebar" : ""}${chatOnly ? " plugin-view--chat" : ""}`}
    >
      {!chatOnly || error ? (
        <header className="plugin-view__head">
          {!embedded ? (
            <>
              <span className="plugin-view__title">{view?.title || t("pluginView.title")}</span>
              <span className="plugin-view__plugin">{pluginId}</span>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            leading={<RefreshCw size={13} />}
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setError(null);
              void load(true);
            }}
          >
            {t("pluginView.refresh")}
          </Button>
        </header>
      ) : null}

      {error ? (
        <div>
          <p className="panel__error" role="alert">
            {error}
          </p>
          <PluginRestrictedAction />
        </div>
      ) : null}

      <div className="plugin-view__body" aria-busy={loading}>
        {view === null ? (
          loading ? (
            <p role="status">{t("common.loading")}</p>
          ) : null
        ) : view.blocks.length === 0 ? (
          <EmptyState title={t("pluginView.empty")} />
        ) : (
          view.blocks.map((block, index) => {
            if (block.type === "mounts") return <PluginMounts key="mounts" pluginId={pluginId} />;
            if (block.type === "chat") {
              return (
                <PluginChat
                  key={`chat:${block.id}`}
                  pluginId={pluginId}
                  viewId={viewId}
                  block={block}
                  visible={visible}
                />
              );
            }
            if (block.type === "form") {
              return (
                <PluginToolForm
                  key={`form:${block.id}`}
                  pluginId={pluginId}
                  viewId={viewId}
                  block={block}
                />
              );
            }
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

function PluginToolForm({
  pluginId,
  viewId,
  block,
}: {
  pluginId: string;
  viewId: string;
  block: PluginFormBlock;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  // Workspace tabs remain mounted while inactive, preserving each tool's drafts and results.
  const key = `tool:${pluginId}:${viewId}:${block.id}`;
  const [draft, setDraft] = useViewState<Record<string, string>>(`${key}:draft`, {});
  const [result, setResult] = useViewState<ReturnType<typeof normalizeResult> | null>(
    `${key}:result`,
    null,
  );
  const [error, setError] = useViewState<string | null>(`${key}:error`, null);
  const [busy, setBusy] = useState<string | null>(null);
  useBackgroundGuard(busy !== null);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );

  const run = async (action: PluginFormBlock["actions"][number]) => {
    if (pending.current) return;
    const input = Object.fromEntries(
      block.fields.map((field) => [field.id, draft[field.id] ?? field.value]),
    );
    input._locale = i18n.resolvedLanguage ?? i18n.language;
    if (new TextEncoder().encode(JSON.stringify(input)).length > PLUGIN_INPUT_MAX_BYTES) {
      setError(t("pluginView.inputTooLarge"));
      return;
    }
    const current = ++generation.current;
    pending.current = true;
    setBusy(action.id);
    setError(null);
    try {
      if (isTauri() && !(await authorizePluginAction(pluginId))) return;
      if (generation.current !== current) return;
      const response = await api.pluginRun(pluginId, action.command, input);
      if (generation.current === current) setResult(normalizeResult(response));
    } catch (cause) {
      reportPluginExecutionFailure(cause);
      if (generation.current === current) {
        setError(
          cause instanceof Error && cause.message === "resultTooLarge"
            ? t("pluginView.resultTooLarge")
            : translateError(cause),
        );
      }
    } finally {
      if (generation.current === current) {
        pending.current = false;
        setBusy(null);
      }
    }
  };

  return (
    <section className="plugin-tool" aria-busy={busy !== null}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const action = block.actions[0];
          if (action) void run(action);
        }}
      >
        <div className="plugin-tool__fields">
          {block.fields.map((field) => {
            const fieldId = `${id}-${field.id}`;
            const value = draft[field.id] ?? field.value;
            const change = (value: string) =>
              setDraft((previous) => ({ ...previous, [field.id]: value }));
            return (
              <Field key={field.id} label={field.label} htmlFor={fieldId}>
                {field.type === "select" ? (
                  <Select
                    id={fieldId}
                    label={field.label}
                    value={value}
                    options={field.options}
                    onChange={change}
                    disabled={busy !== null}
                  />
                ) : field.type === "textarea" ? (
                  <Textarea
                    id={fieldId}
                    value={value}
                    placeholder={field.placeholder}
                    rows={10}
                    spellCheck={false}
                    onChange={(event) => change(event.target.value)}
                  />
                ) : (
                  <Input
                    id={fieldId}
                    type={field.type === "password" ? "password" : "text"}
                    autoComplete="off"
                    value={value}
                    placeholder={field.placeholder}
                    spellCheck={false}
                    onChange={(event) => change(event.target.value)}
                  />
                )}
              </Field>
            );
          })}
        </div>
        <div className="plugin-tool__actions">
          {block.actions.map((action, index) => (
            <Button
              key={action.id}
              type={index === 0 ? "submit" : "button"}
              variant={index === 0 ? "primary" : "secondary"}
              disabled={busy !== null}
              onClick={index === 0 ? undefined : () => void run(action)}
            >
              {busy === action.id ? t("pluginView.running") : action.label}
            </Button>
          ))}
        </div>
      </form>
      {error ? (
        <div>
          <p className="panel__error" role="alert">
            {error}
          </p>
          <PluginRestrictedAction />
        </div>
      ) : null}
      {result !== null ? (
        <div className={`plugin-tool__result${result.error ? " is-error" : ""}`}>
          <div className="plugin-tool__result-head">
            <label htmlFor={`${id}-result`}>{result.title || t("pluginView.result")}</label>
            <Button
              variant="ghost"
              size="sm"
              leading={<Copy size={13} />}
              onClick={() => copyText(result.text)}
            >
              {t("pluginView.copyResult")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
              {t("pluginView.clearResult")}
            </Button>
          </div>
          <Textarea
            id={`${id}-result`}
            readOnly
            value={result.text}
            rows={10}
            spellCheck={false}
            aria-invalid={result.error || undefined}
          />
          {result.error ? (
            <span role="alert" className="plugin-tool__announcement">
              {result.text}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
