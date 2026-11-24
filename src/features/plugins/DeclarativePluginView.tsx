import { RefreshCw } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { Field, Input, Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { presentError } from "@/lib/api/errors";
import { isPluginInvocationCancelled } from "@/lib/plugins/commands/errors";
import {
  type normalizeResult,
  PLUGIN_INPUT_MAX_BYTES,
  type PluginBlock,
  type PluginField,
  type PluginFormBlock,
} from "@/lib/plugins/pluginView";
import type { DeclarativePluginView, DeclarativeViewOwner } from "@/lib/plugins/views/declarative";
import type { usePanelViewStateBridge } from "@/lib/panels/viewState";
import { PluginCommandResultView } from "./PluginCommandResultView";
import "@/styles/pluginTools.css";

export interface DeclarativeViewServices {
  run: DeclarativeViewOwner["run"];
  useViewState: typeof usePanelViewStateBridge;
  useSecretState: <T>(
    key: string,
    initial: T | (() => T),
    validate: (value: unknown) => value is T,
  ) => [T, (next: T | ((previous: T) => T)) => void];
  useBusyGuard: (busy: boolean) => void;
}
/** All JSON blocks retain the same renderer. Domain blocks and effects are
 * explicit slots, not hidden main-window stores or a builtin substitution. */
export function DeclarativePluginView({
  pluginId,
  viewId,
  embedded,
  view,
  loading,
  error,
  onRefresh,
  services,
  reportFailure,
  errorAction,
  copyResult,
  renderDomainBlock,
}: {
  pluginId: string;
  viewId: string;
  embedded?: boolean;
  view: DeclarativePluginView | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  services: DeclarativeViewServices;
  reportFailure: (cause: unknown) => void;
  errorAction: ReactNode;
  copyResult: (text: string) => void | Promise<unknown>;
  renderDomainBlock: (block: PluginBlock) => ReactNode;
}) {
  const { t } = useTranslation();
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
            onClick={onRefresh}
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
          {errorAction}
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
            if (block.type === "mounts" || block.type === "sharedMounts" || block.type === "chat")
              return (
                <Fragment key={block.type === "chat" ? `chat:${block.id}` : block.type}>
                  {renderDomainBlock(block)}
                </Fragment>
              );
            if (block.type === "form") {
              return (
                <PluginToolForm
                  key={`form:${block.id}`}
                  pluginId={pluginId}
                  viewId={viewId}
                  block={block}
                  revision={view.revision}
                  services={services}
                  reportFailure={reportFailure}
                  errorAction={errorAction}
                  copyResult={copyResult}
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

const isRecord = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");
const isResultOrNull = (value: unknown): value is ReturnType<typeof normalizeResult> | null =>
  value === null ||
  (!!value &&
    typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { error?: unknown }).error === "boolean");
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function PluginToolForm({
  pluginId,
  viewId,
  block,
  revision,
  services,
  reportFailure,
  errorAction,
  copyResult,
}: {
  pluginId: string;
  viewId: string;
  block: PluginFormBlock;
  revision: string;
  services: DeclarativeViewServices;
  reportFailure: (cause: unknown) => void;
  errorAction: ReactNode;
  copyResult: (text: string) => void | Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  // Workspace tabs remain mounted while inactive, preserving each tool's drafts and results.
  const key = `tool:${pluginId}:${viewId}:${block.id}`;
  const [plainDraft, setPlainDraft] = services.useViewState<Record<string, string>>(
    `${key}:draft`,
    {},
    isRecord,
  );
  const [secretDraft, setSecretDraft] = services.useSecretState<Record<string, string>>(
    `${key}:secret`,
    {},
    isRecord,
  );
  const setDraft = setPlainDraft;
  const [result, setResult] = services.useViewState<ReturnType<typeof normalizeResult> | null>(
    `${key}:result`,
    null,
    isResultOrNull,
  );
  const [error, setError] = services.useViewState<string | null>(
    `${key}:error`,
    null,
    isStringOrNull,
  );
  const [busy, setBusy] = useState<string | null>(null);
  services.useBusyGuard(busy !== null);
  const pending = useRef(false);
  const invocation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      ++generation.current;
      invocation.current?.abort();
    },
    [],
  );

  const fieldValue = (field: PluginField) => {
    const value = field.type === "password" ? (secretDraft[field.id] ?? "") : plainDraft[field.id];
    if (
      value === undefined ||
      (field.type === "select" && !field.options.some((option) => option.value === value))
    )
      return field.value;
    return value;
  };

  const run = async (action: PluginFormBlock["actions"][number]) => {
    if (pending.current) return;
    const input = Object.fromEntries(block.fields.map((field) => [field.id, fieldValue(field)]));
    input._locale = i18n.resolvedLanguage ?? i18n.language;
    if (new TextEncoder().encode(JSON.stringify(input)).length > PLUGIN_INPUT_MAX_BYTES) {
      setError(t("pluginView.inputTooLarge"));
      return;
    }
    const current = ++generation.current;
    pending.current = true;
    const controller = new AbortController();
    invocation.current = controller;
    setBusy(action.id);
    setError(null);
    try {
      const response = await services.run(
        {
          revision,
          formId: block.id,
          actionId: action.id,
          values: Object.fromEntries(block.fields.map((field) => [field.id, fieldValue(field)])),
          locale: i18n.resolvedLanguage ?? i18n.language,
        },
        controller.signal,
      );
      if (generation.current === current) setResult(response);
    } catch (cause) {
      if (
        isPluginInvocationCancelled(cause) ||
        (cause instanceof Error &&
          ["plugin.permissionDenied", "plugin.invocation.cancelled"].includes(cause.message))
      )
        return;
      reportFailure(cause);
      if (generation.current === current) {
        setError(
          cause instanceof Error && ["resultTooLarge", "inputTooLarge"].includes(cause.message)
            ? t(
                cause.message === "resultTooLarge"
                  ? "pluginView.resultTooLarge"
                  : "pluginView.inputTooLarge",
              )
            : presentError(cause),
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
            const value = fieldValue(field);
            const change = (value: string) => {
              if (field.type === "password")
                setSecretDraft((previous) => ({ ...previous, [field.id]: value }));
              else setDraft((previous) => ({ ...previous, [field.id]: value }));
            };
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
                    className="td-code-editor"
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
          {errorAction}
        </div>
      ) : null}
      {result !== null ? (
        <PluginCommandResultView
          result={result}
          onClear={() => setResult(null)}
          onCopy={copyResult}
        />
      ) : null}
    </section>
  );
}
