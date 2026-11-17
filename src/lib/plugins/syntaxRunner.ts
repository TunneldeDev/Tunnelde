import { api } from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { editorDocument } from "@/store/editors";
import type { SyntaxDocumentSnapshot } from "@/features/editor/syntax/useEditorSyntax";
import i18n from "@/i18n/i18n";
import { samePluginAction } from "./commands/identity";
import { samePluginRuntime } from "./commands/runtime";
import {
  editorSyntaxMatches,
  syntaxScalarBoundary,
  parseSyntaxResult,
  SYNTAX_REQUEST_MAX_BYTES,
  SYNTAX_RESULT_MAX_BYTES,
  SYNTAX_SOURCE_MAX_BYTES,
  type SyntaxProvider,
  type SyntaxToken,
} from "./syntax";
import type {
  SyntaxDocumentMetadata,
  SyntaxProviderRequest,
  SyntaxWindowRequest,
} from "./syntaxProtocol";
import { syntaxWindow } from "./syntaxProtocol";

const textBytes = (value: string) => new TextEncoder().encode(value).length;

function documentExtension(path: string, supported: readonly string[]): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return (
    supported.find((extension) => name.endsWith(`.${extension.toLowerCase()}`)) ??
    supported[0] ??
    ""
  );
}

export interface SyntaxHighlightTarget {
  provider: SyntaxProvider;
  document: SyntaxDocumentSnapshot;
  window?: { offset: number; length: number } | null;
}

function metadata(document: SyntaxDocumentSnapshot): SyntaxDocumentMetadata {
  return {
    tabId: document.tabId,
    documentId: document.documentId,
    version: document.version,
    path: document.path,
    name: document.name,
  };
}

function requestFor(target: SyntaxHighlightTarget): SyntaxProviderRequest | null {
  const document = target.document;
  const sourceBytes = textBytes(document.content);
  if (!target.window && sourceBytes > SYNTAX_SOURCE_MAX_BYTES) return null;
  if (target.window) {
    let window: { offset: number; length: number };
    try {
      window = syntaxWindow(target.window.offset, target.window.length);
    } catch {
      return null;
    }
    const end = window.offset + window.length;
    if (
      end > document.content.length ||
      !syntaxScalarBoundary(document.content, window.offset) ||
      !syntaxScalarBoundary(document.content, end)
    )
      return null;
    const request: SyntaxWindowRequest = {
      mode: "window",
      source: null,
      document: metadata(document),
      extensions: [documentExtension(document.path, target.provider.extensions)],
      range: window,
      _locale: i18n.resolvedLanguage ?? i18n.language,
    };
    return textBytes(JSON.stringify(request)) <= SYNTAX_REQUEST_MAX_BYTES ? request : null;
  }
  const request = {
    mode: "inline" as const,
    source: document.content,
    document: metadata(document),
    extensions: target.provider.extensions,
    _locale: i18n.resolvedLanguage ?? i18n.language,
  };
  return textBytes(JSON.stringify(request)) <= SYNTAX_REQUEST_MAX_BYTES ? request : null;
}

function authorized(plugin: PluginInfo): boolean {
  const security = usePluginSecurity.getState().state;
  if (security.restricted) return false;
  // Direct runner calls still require an explicit grant. The hook separately
  // treats browser tests without a Tauri bridge as already-authorized.
  return plugin.permissions.every((permission) => security.grants[plugin.id]?.includes(permission));
}

/** Auto-highlighting never starts a plugin or requests consent. It invokes one
 * already-running provider and falls back to no decorations on uncertainty. */
export async function runSyntaxHighlighting(
  target: SyntaxHighlightTarget,
  signal: AbortSignal,
): Promise<SyntaxToken[] | null> {
  if (signal.aborted) return null;
  const { provider, document } = target;
  const original = usePlugins.getState().items.find((item) => item.id === provider.id);
  const command = original?.commands.find((item) => item.id === provider.command);
  if (
    !original ||
    original.status !== "running" ||
    !command?.editor?.syntax ||
    command.editor.format === true ||
    !editorSyntaxMatches(document.path, command.editor.extensions) ||
    !original.permissions.includes("editor.read") ||
    !authorized(original)
  )
    return null;
  const request = requestFor(target);
  if (!request) return null;
  try {
    const result = await api.pluginRun(
      provider.id,
      provider.command,
      request as unknown as Record<string, unknown>,
      original.runtimeId ?? "",
    );
    if (signal.aborted) return null;
    const latest = usePlugins.getState().items.find((item) => item.id === provider.id);
    const current = editorDocument(document.tabId);
    if (
      !current ||
      current.documentId !== document.documentId ||
      current.version !== document.version ||
      !samePluginAction(latest, original, { id: provider.id, command: provider.command }) ||
      latest.status !== "running" ||
      !samePluginRuntime(latest, original) ||
      !authorized(latest)
    )
      return null;
    const source = target.window
      ? document.content.slice(target.window.offset, target.window.offset + target.window.length)
      : document.content;
    const tokens = parseSyntaxResult(result, source);
    if (textBytes(JSON.stringify({ tokens })) > SYNTAX_RESULT_MAX_BYTES) return null;
    return tokens;
  } catch {
    return null;
  }
}
