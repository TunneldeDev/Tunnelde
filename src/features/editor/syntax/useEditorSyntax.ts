import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/api/ipc";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import {
  editorSyntaxMatches,
  syntaxProviders,
  syntaxScalarBoundary,
  type SyntaxProvider,
  type SyntaxToken,
} from "@/lib/plugins/syntax";
import { runSyntaxHighlighting } from "@/lib/plugins/syntaxRunner";
import { SYNTAX_WINDOW_MAX_UTF16 } from "@/lib/plugins/syntaxProtocol";

const DEBOUNCE_MS = 220;
const REQUEST_TIMEOUT_MS = 5_000;

export interface SyntaxDocumentSnapshot {
  tabId: string;
  documentId: string;
  version: number;
  path: string;
  name: string;
  content: string;
  dirty: boolean;
}

export interface SyntaxRequestedRange {
  offset: number;
  length: number;
}

export interface SyntaxHighlightState {
  tokens: readonly SyntaxToken[];
  documentId: string | null;
  version: number | null;
  provider: string | null;
  range: SyntaxRequestedRange | null;
  highlighted: boolean;
}

const EMPTY: SyntaxHighlightState = {
  tokens: [],
  documentId: null,
  version: null,
  provider: null,
  range: null,
  highlighted: false,
};

export interface UseEditorSyntaxOptions {
  document: SyntaxDocumentSnapshot | null;
  composing: boolean;
  enabled: boolean;
  /** For larger documents, the CM host supplies the settled visible window. */
  requestedRange?: SyntaxRequestedRange | null;
}

interface RenderedTokens {
  tokens: SyntaxToken[];
  documentId: string;
  version: number;
  content: string;
  provider: string;
  runtime: string;
  range: SyntaxRequestedRange | null;
}

/** Framework-neutral semantic-token state. The CM adapter applies the returned
 * tokens as decorations; this hook owns provider discovery, auth and fencing. */
export function useEditorSyntax({
  document,
  composing,
  enabled,
  requestedRange = null,
}: UseEditorSyntaxOptions): SyntaxHighlightState {
  const plugins = usePlugins((state) => state.items);
  const security = usePluginSecurity((state) => state.state);
  const tabId = document?.tabId ?? "";
  const documentId = document?.documentId ?? "";
  const version = document?.version ?? -1;
  const content = document?.content ?? "";
  const path = document?.path ?? "";
  const name = document?.name ?? "";
  const dirty = document?.dirty ?? false;
  const providers = useMemo(() => (path ? syntaxProviders(path, plugins) : []), [path, plugins]);
  const stoppingIds = usePlugins((state) => state.stoppingIds);
  const provider = useMemo(() => {
    for (const candidate of providers) {
      const info = plugins.find((item) => item.id === candidate.id);
      const command = info?.commands.find((item) => item.id === candidate.command);
      if (
        info?.status === "running" &&
        !stoppingIds.includes(info.id) &&
        info.permissions.includes("editor.read") &&
        command?.editor?.syntax &&
        command.editor.format !== true &&
        (!isTauri() || (!security.restricted && hasPluginGrant(security, info)))
      )
        return candidate;
    }
    return null;
  }, [plugins, providers, security, stoppingIds]);
  const providerKey = provider
    ? `${provider.id}:${provider.command}:${provider.extensions.join(",")}`
    : "";
  const plugin = provider ? plugins.find((item) => item.id === provider.id) : undefined;
  const command = plugin?.commands.find((item) => item.id === provider?.command);
  const compatible =
    !!command?.editor?.syntax &&
    !command.editor.format &&
    editorSyntaxMatches(path, command.editor.extensions);
  const stopping = provider ? stoppingIds.includes(provider.id) : false;
  const runtime = plugin
    ? `${plugin.status}:${plugin.fingerprint ?? ""}:${plugin.runtimeId ?? ""}:${plugin.permissions.join(",")}:${stopping}`
    : "";
  const authorized =
    !provider ||
    (!security.restricted && !!plugin && (isTauri() ? hasPluginGrant(security, plugin) : true));
  const sourceLength = content.length;
  const requestedOffset = requestedRange?.offset ?? null;
  const requestedLength = requestedRange?.length ?? null;
  const sourceBytes = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const windowed = sourceBytes > 128 * 1024;
  const requestRange = useMemo(() => {
    if (
      !windowed ||
      requestedOffset === null ||
      requestedLength === null ||
      requestedOffset < 0 ||
      requestedLength <= 0 ||
      requestedOffset >= sourceLength
    )
      return null;
    const end = Math.min(sourceLength, requestedOffset + requestedLength);
    const offset = syntaxScalarBoundary(content, requestedOffset)
      ? requestedOffset
      : requestedOffset - 1;
    const boundedEnd = syntaxScalarBoundary(content, end) ? end : end - 1;
    if (
      offset < 0 ||
      boundedEnd <= offset ||
      !syntaxScalarBoundary(content, offset) ||
      !syntaxScalarBoundary(content, boundedEnd)
    )
      return null;
    const cappedEnd = Math.min(boundedEnd, offset + SYNTAX_WINDOW_MAX_UTF16);
    const finalEnd = syntaxScalarBoundary(content, cappedEnd) ? cappedEnd : cappedEnd - 1;
    if (finalEnd <= offset || !syntaxScalarBoundary(content, finalEnd)) return null;
    return { offset, length: finalEnd - offset };
  }, [content, requestedLength, requestedOffset, sourceLength, windowed]);
  const rangeKey = requestRange ? `${requestRange.offset}:${requestRange.length}` : "";
  const requestable = !windowed || requestRange !== null;
  const [rendered, setRendered] = useState<RenderedTokens | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    const valid =
      !!tabId &&
      !!documentId &&
      enabled &&
      !composing &&
      !!provider &&
      plugin?.status === "running" &&
      !stopping &&
      compatible &&
      authorized &&
      requestable;
    if (!valid) {
      sequence.current += 1;
      return;
    }
    const currentSequence = ++sequence.current;
    const snapshot: SyntaxDocumentSnapshot = {
      tabId,
      documentId,
      version,
      path,
      name,
      content,
      dirty,
    };
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DEBOUNCE_MS + REQUEST_TIMEOUT_MS);
    const debounce = window.setTimeout(() => {
      void runSyntaxHighlighting(
        { provider, document: snapshot, window: requestRange },
        controller.signal,
      ).then((tokens) => {
        if (controller.signal.aborted || currentSequence !== sequence.current || !tokens) return;
        setRendered({
          tokens,
          documentId,
          version,
          content,
          provider: providerKey,
          runtime,
          range: requestRange,
        });
      });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(debounce);
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    authorized,
    compatible,
    composing,
    content,
    dirty,
    documentId,
    enabled,
    name,
    path,
    plugin?.status,
    sourceBytes,
    provider,
    providerKey,
    rangeKey,
    requestable,
    requestRange,
    runtime,
    stopping,
    tabId,
    version,
  ]);

  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  if (
    !rendered ||
    !tabId ||
    !documentId ||
    !enabled ||
    composing ||
    rendered.documentId !== documentId ||
    rendered.version !== version ||
    rendered.content !== content ||
    rendered.provider !== providerKey ||
    rendered.runtime !== runtime ||
    !authorized ||
    plugin?.status !== "running" ||
    stopping ||
    !compatible ||
    !requestable ||
    (windowed &&
      (!rendered.range ||
        rendered.range.offset !== requestRange?.offset ||
        rendered.range.length !== requestRange?.length))
  )
    return EMPTY;
  return {
    tokens: rendered.tokens,
    documentId: rendered.documentId,
    version: rendered.version,
    provider: rendered.provider,
    range: rendered.range,
    highlighted: rendered.tokens.length > 0,
  };
}

export function syntaxProviderForDocument(
  document: SyntaxDocumentSnapshot,
  plugins: readonly ReturnType<typeof usePlugins.getState>["items"][number][],
): SyntaxProvider | null {
  return syntaxProviders(document.path, plugins)[0] ?? null;
}
