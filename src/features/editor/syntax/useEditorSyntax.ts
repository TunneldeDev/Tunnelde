import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@/lib/api/ipc";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { editorSyntaxMatches, syntaxProviders, type SyntaxToken } from "@/lib/plugins/syntax";
import { runSyntaxHighlighting } from "@/lib/plugins/syntaxRunner";

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

export interface SyntaxHighlightState {
  tokens: readonly SyntaxToken[];
  documentId: string | null;
  version: number | null;
  highlighted: boolean;
}

const EMPTY: SyntaxHighlightState = {
  tokens: [],
  documentId: null,
  version: null,
  highlighted: false,
};

/** Framework-neutral semantic-token state. A textarea overlay and a future
 * CodeMirror decoration consumer can share this without owning editor geometry. */
export function useEditorSyntax({
  document,
  composing,
  enabled,
}: {
  document: SyntaxDocumentSnapshot | null;
  composing: boolean;
  enabled: boolean;
}): SyntaxHighlightState {
  const plugins = usePlugins((state) => state.items);
  const security = usePluginSecurity((state) => state.state);
  const tabId = document?.tabId ?? "";
  const documentId = document?.documentId ?? "";
  const version = document?.version ?? -1;
  const content = document?.content ?? "";
  const path = document?.path ?? "";
  const name = document?.name ?? "";
  const dirty = document?.dirty ?? false;
  const provider = useMemo(
    () => (path ? (syntaxProviders(path, plugins)[0] ?? null) : null),
    [path, plugins],
  );
  const providerKey = provider
    ? `${provider.id}:${provider.command}:${provider.extensions.join(",")}`
    : "";
  const plugin = provider ? plugins.find((item) => item.id === provider.id) : undefined;
  const command = plugin?.commands.find((item) => item.id === provider?.command);
  const compatible =
    !!command?.editor?.syntax &&
    !command.editor.format &&
    editorSyntaxMatches(path, command.editor.extensions);
  const stopping = usePlugins((state) =>
    provider ? state.stoppingIds.includes(provider.id) : false,
  );
  const runtime = plugin
    ? `${plugin.status}:${plugin.fingerprint ?? ""}:${plugin.runtimeId ?? ""}:${plugin.permissions.join(",")}:${stopping}`
    : "";
  const authorized =
    !provider ||
    !isTauri() ||
    (!security.restricted && !!plugin && hasPluginGrant(security, plugin));
  const [rendered, setRendered] = useState<
    (SyntaxHighlightState & { content: string; provider: string; runtime: string }) | null
  >(null);
  const sequence = useRef(0);
  const queued = useRef<{
    document: SyntaxDocumentSnapshot;
    provider: NonNullable<typeof provider>;
    providerKey: string;
    runtime: string;
    sequence: number;
  } | null>(null);
  const running = useRef<{ sequence: number; controller: AbortController } | null>(null);

  const startNext = useCallback(() => {
    if (running.current) return;
    const job = queued.current;
    queued.current = null;
    if (!job) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    running.current = { sequence: job.sequence, controller };
    void runSyntaxHighlighting(job.provider, job.document, controller.signal)
      .then((tokens) => {
        if (controller.signal.aborted || job.sequence !== sequence.current || !tokens) return;
        setRendered({
          tokens,
          documentId: job.document.documentId,
          version: job.document.version,
          highlighted: tokens.length > 0,
          content: job.document.content,
          provider: job.providerKey,
          runtime: job.runtime,
        });
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (running.current?.sequence === job.sequence) running.current = null;
        startNext();
      });
  }, []);

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
      authorized;
    if (!valid) {
      sequence.current += 1;
      queued.current = null;
      running.current?.controller.abort();
      running.current = null;
      setRendered((value) => (value === null ? value : null));
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
    const timer = window.setTimeout(() => {
      queued.current = {
        document: snapshot,
        provider,
        providerKey,
        runtime,
        sequence: currentSequence,
      };
      startNext();
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
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
    provider,
    providerKey,
    runtime,
    startNext,
    stopping,
    tabId,
    version,
  ]);

  useEffect(
    () => () => {
      sequence.current += 1;
      queued.current = null;
      running.current?.controller.abort();
      running.current = null;
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
    content.length > 128 * 1024
  )
    return EMPTY;
  return rendered;
}
