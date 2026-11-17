import { api, isTauri } from "@/lib/api/ipc";
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
  parseSyntaxResult,
  SYNTAX_REQUEST_MAX_BYTES,
  SYNTAX_RESULT_MAX_BYTES,
  SYNTAX_SOURCE_MAX_BYTES,
  type SyntaxProvider,
  type SyntaxToken,
} from "./syntax";

const textBytes = (value: string) => new TextEncoder().encode(value).length;

/** Auto-highlighting never starts a plugin, requests consent, or surfaces errors.
 * It only invokes an already running, already authorized provider for one exact
 * document snapshot and falls back to plain text on every uncertainty. */
export async function runSyntaxHighlighting(
  provider: SyntaxProvider,
  document: SyntaxDocumentSnapshot,
  signal: AbortSignal,
): Promise<SyntaxToken[] | null> {
  if (signal.aborted) return null;
  const original = usePlugins.getState().items.find((item) => item.id === provider.id);
  const command = original?.commands.find((item) => item.id === provider.command);
  if (
    !original ||
    original.status !== "running" ||
    !command?.editor?.syntax ||
    command.editor.format === true ||
    !editorSyntaxMatches(document.path, command.editor.extensions) ||
    !original.permissions.includes("editor.read")
  )
    return null;
  const sourceBytes = textBytes(document.content);
  if (sourceBytes > SYNTAX_SOURCE_MAX_BYTES) return null;
  const input = {
    source: document.content,
    document: {
      tabId: document.tabId,
      documentId: document.documentId,
      version: document.version,
      path: document.path,
      name: document.name,
    },
    extensions: provider.extensions,
    _locale: i18n.resolvedLanguage ?? i18n.language,
  };
  if (textBytes(JSON.stringify(input)) > SYNTAX_REQUEST_MAX_BYTES) return null;
  const security = () => usePluginSecurity.getState().state;
  const authorized = (plugin: PluginInfo) =>
    !security().restricted &&
    (isTauri()
      ? plugin.permissions.every((permission) =>
          security().grants[plugin.id]?.includes(permission),
        )
      : plugin.permissions.every((permission) => plugin.permissions.includes(permission)));
  if (!authorized(original)) return null;
  try {
    const result = await api.pluginRun(
      provider.id,
      provider.command,
      input,
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
    const tokens = parseSyntaxResult(result, document.content);
    if (textBytes(JSON.stringify({ tokens })) > SYNTAX_RESULT_MAX_BYTES) return null;
    return tokens;
  } catch {
    return null;
  }
}
