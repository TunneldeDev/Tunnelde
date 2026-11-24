import { SYNTAX_TOKEN_TYPES } from "@/lib/plugins/syntax";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { PanelHeader } from "@/components/layout/WorkbenchPanel";
import { SquareArrowOutUpRight } from "lucide-react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { presentError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { fileName } from "@/store/editors";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";
import type { PreviewWindowData } from "./windowModel";
import { PreviewBody } from "./PreviewBody";
import { PreviewRenderer, type PreviewRenderRead } from "./PreviewRenderer";
import { createWindowPreviewContext } from "./windowContext";
import { WindowPreviewProvider } from "./WindowPreviewProvider";
import { useWindowPreviewHandle } from "./useWindowPreviewHandle";
import type { PreviewSyntaxSource } from "./usePreviewSyntax";
import type { PreviewWindowAction, PreviewSyntaxReply } from "./windowActions";

interface BodyFrame {
  data: PreviewWindowData;
  read: PreviewRenderRead;
  url?: string;
  active: boolean;
  syntax?: PreviewSyntaxSource;
  onReady(): void;
  onDecodeError(cause: unknown): void;
  retry(): void;
}
const Context = createContext<BodyFrame | null>(null);
function Body() {
  const frame = useContext(Context);
  if (!frame) throw new Error("plugin.filePreview.changed");
  const snapshot = frame.data.snapshot;
  return (
    <PreviewRenderer
      file={{
        path: snapshot.path,
        line: snapshot.line,
        column: snapshot.column,
        source: snapshot.source,
      }}
      renderer={snapshot.renderer}
      read={frame.read}
      url={frame.url}
      active={frame.active}
      syntax={frame.syntax}
      onReady={frame.onReady}
      onDecodeError={frame.onDecodeError}
      onRetry={frame.retry}
    />
  );
}
/** Production view-only consumer. The caller supplies native controller /
 * interaction scopes; this component never bootstraps main feature stores. */
export function WindowPreview({
  owner,
  data,
  active,
  mainUrl,
}: {
  owner: WindowProviderOwner;
  data: PreviewWindowData;
  active: boolean;
  mainUrl?: string;
}) {
  return (
    <PreviewBody attemptId={data.snapshot.attemptId}>
      <Attempt
        key={data.snapshot.attemptId}
        owner={owner}
        data={data}
        active={active}
        mainUrl={mainUrl}
      />
    </PreviewBody>
  );
}
function Attempt({
  owner,
  data,
  active,
  mainUrl,
}: {
  owner: WindowProviderOwner;
  data: PreviewWindowData;
  active: boolean;
  mainUrl?: string;
}) {
  const { t } = useTranslation();
  const snapshot = data.snapshot;
  const [decoded, setDecoded] = useState(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const latest = useRef(snapshot);
  useLayoutEffect(() => {
    latest.current = snapshot;
  }, [snapshot]);
  const validateTarget = () => owner.check(false);
  const validate = () => {
    owner.check(false);
    const current = latest.current;
    if (
      current.id !== snapshot.id ||
      current.attemptId !== snapshot.attemptId ||
      current.revision !== snapshot.revision
    )
      throw new Error("plugin.filePreview.changed");
  };
  const action = async (request: PreviewWindowAction, signal?: AbortSignal) => {
    validate();
    owner.check(true);
    const target = owner.target();
    if (target.kind !== "owned") throw new Error("panel.window.staleOwner");
    return owner.client.action(target.lease, request, signal);
  };
  /* eslint-disable react-hooks/refs -- Context factory only retains validators for later operations. */
  const context = createWindowPreviewContext(data, validate, (request) => {
    const result = action(request);
    void result.catch((error) => reportError("panels.preview", "action", error));
    return result;
  });
  /* eslint-enable react-hooks/refs */
  const resourceId =
    owner.client.windowId !== "main" &&
    data.read.status === "ready" &&
    snapshot.renderer !== "text" &&
    snapshot.renderer !== "markdown"
      ? (data.read.resource?.id ?? null)
      : null;
  const syntax = useMemo<PreviewSyntaxSource | undefined>(
    () =>
      data.syntaxKey
        ? {
            key: data.syntaxKey,
            highlight: async (_document, range, signal) => {
              owner.check(true);
              const target = owner.target();
              if (target.kind !== "owned") return null;
              const tokens = await owner.client.action<PreviewSyntaxReply>(
                target.lease,
                {
                  kind: "preview",
                  id: snapshot.id,
                  attemptId: snapshot.attemptId,
                  revision: snapshot.revision,
                  command: { operation: "syntax", from: range.from, to: range.to },
                },
                signal,
              );
              return (
                tokens?.map(([start, end, type]) => {
                  const semanticType = SYNTAX_TOKEN_TYPES[type];
                  if (!semanticType) throw new Error("invalid:syntaxToken");
                  return { start, end, type: semanticType };
                }) ?? null
              );
            },
          }
        : undefined,
    [owner, data.syntaxKey, snapshot.id, snapshot.attemptId, snapshot.revision],
  );
  const handle = useWindowPreviewHandle(owner, resourceId);
  const onReady = useCallback(() => setDecoded(true), []);
  const onDecodeError = useCallback((cause: unknown) => setFailure({ cause }), []);
  // Rendering/readiness of an inert staged destination is local only. Submit
  // state changes after native commit, never mutate the source during staging.
  useEffect(() => {
    if (
      !active ||
      (!decoded && !failure) ||
      (failure ? snapshot.state === "error" : snapshot.state !== "loading")
    )
      return;
    const lifetime = new AbortController();
    try {
      const target = owner.target();
      owner.check(true);
      if (target.kind !== "owned") return;
      void owner.client
        .action(
          target.lease,
          {
            kind: "preview",
            id: snapshot.id,
            attemptId: snapshot.attemptId,
            revision: snapshot.revision,
            command: { operation: failure ? "decodeError" : "ready" },
          },
          lifetime.signal,
        )
        .catch((error) => {
          if (
            !lifetime.signal.aborted &&
            !(error instanceof Error && error.message === "plugin.filePreview.changed")
          )
            reportError("panels.preview", "state", error);
        });
    } catch {
      /* A staged or frozen tree has no effect authority yet. */
    }
    return () => lifetime.abort();
  }, [
    owner,
    active,
    decoded,
    failure,
    snapshot.id,
    snapshot.attemptId,
    snapshot.revision,
    snapshot.state,
  ]);
  const read: PreviewRenderRead = failure
    ? { status: "error", message: presentError(failure.cause) }
    : handle.status === "error"
      ? { status: "error", message: presentError(handle.cause) }
      : data.read;
  const url =
    owner.client.windowId === "main" ? mainUrl : handle.status === "ready" ? handle.url : undefined;
  return (
    <div className="sidebar file-preview-panel">
      <PanelHeader view="filePreview" managed>
        <div className="sidebar__actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={!active || (snapshot.renderer !== "text" && snapshot.renderer !== "markdown")}
            onClick={() => {
              void action({
                kind: "preview",
                id: snapshot.id,
                revision: snapshot.revision,
                attemptId: snapshot.attemptId,
                command: { operation: "edit" },
              }).catch((error) => reportError("panels.preview", "edit", error));
            }}
          >
            {t("sftp.edit")}
          </Button>
          {owner.client.windowId === "main" ? (
            <IconButton
              label={t("preview.undock")}
              disabled={!active}
              onClick={() => {
                void action({
                  kind: "preview",
                  id: snapshot.id,
                  revision: snapshot.revision,
                  attemptId: snapshot.attemptId,
                  command: { operation: "undock" },
                }).catch((error) => reportError("panels.preview", "undock", error));
              }}
            >
              <SquareArrowOutUpRight size={14} />
            </IconButton>
          ) : null}
        </div>
      </PanelHeader>
      <div className="file-preview-panel__body">
        <div className="file-preview__content">
          <div className="file-preview__target">
            <div>
              <strong>{fileName(snapshot.path)}</strong>
              <p className="settings-hint" title={snapshot.path}>
                {snapshot.path}
              </p>
            </div>
          </div>
          {data.providers.length > 1 ? (
            <Select
              value={snapshot.providerId ?? ""}
              options={data.providers.map((p) => ({ value: p.id, label: p.name }))}
              disabled={!active}
              onChange={context.selectProvider}
              label={t("preview.provider")}
            />
          ) : null}
          <Context.Provider
            value={{
              data,
              read,
              url,
              active,
              syntax,
              onReady,
              onDecodeError,
              retry: context.retry,
            }}
          >
            <WindowPreviewProvider
              owner={owner}
              data={data}
              Body={Body}
              validate={validate}
              validateTarget={validateTarget}
              visible={active}
            />
          </Context.Provider>
        </div>
      </div>
    </div>
  );
}
