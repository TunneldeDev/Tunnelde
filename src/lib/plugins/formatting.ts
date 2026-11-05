import { create } from "zustand";
import type { PluginInfo } from "@/lib/api/types";
import { isTauri } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity, hasPluginGrant } from "@/store/pluginSecurity";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import {
  editorDocument,
  replaceEditorDocument,
  EDITOR_DOCUMENT_MAX_BYTES,
  type EditorDocument,
} from "@/store/editors";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import i18n from "@/i18n/i18n";

export interface EditorProvider {
  id: string;
  command: string;
  title: string;
}
export const useFormatting = create<{
  busy: string[];
  picker: { document: EditorDocument; providers: EditorProvider[] } | null;
}>(() => ({ busy: [], picker: null }));

export function editorCommandMatches(path: string, extensions: readonly string[]): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return extensions.some((extension) => name.endsWith(`.${extension.toLowerCase()}`));
}

export function documentFormatters(path: string, plugins: readonly PluginInfo[]): EditorProvider[] {
  return plugins.flatMap((plugin) =>
    plugin.commands
      .filter(
        (command) =>
          command.editor?.format && editorCommandMatches(path, command.editor.extensions),
      )
      .map((command) => ({
        id: plugin.id,
        command: command.id,
        title: `${plugin.name}: ${command.title}`,
      })),
  );
}

/** A command invocation binds to one snapshot, even across consent and slow providers. */
export async function runEditorPlugin(
  provider: EditorProvider,
  document: EditorDocument,
): Promise<boolean> {
  if (useFormatting.getState().busy.includes(document.tabId)) return false;
  useFormatting.setState((state) => ({ busy: [...state.busy, document.tabId] }));
  try {
    let plugin = usePlugins.getState().items.find((item) => item.id === provider.id);
    const command = plugin?.commands.find((item) => item.id === provider.command);
    if (
      !plugin ||
      !command?.editor ||
      !editorCommandMatches(document.path, command.editor.extensions)
    )
      throw new Error(i18n.t("editor.noFormatter"));
    if (plugin.status !== "running") await usePlugins.getState().start(plugin.id);
    plugin = usePlugins.getState().items.find((item) => item.id === provider.id);
    if (plugin?.status !== "running") return false;
    const fingerprint = plugin.fingerprint;
    // Consent can take time. Do not send a closed or superseded document to the plugin.
    const current = editorDocument(document.tabId);
    if (
      !current ||
      current.documentId !== document.documentId ||
      current.version !== document.version
    )
      throw new Error(i18n.t("editor.documentChanged"));
    const input = {
      source: document.content,
      document: {
        tabId: document.tabId,
        documentId: document.documentId,
        version: document.version,
        path: document.path,
        name: document.name,
      },
      indent: String(useSettings.getState().settings.editorTabSize),
      _locale: i18n.resolvedLanguage ?? i18n.language,
    };
    if (
      new TextEncoder().encode(document.content).length > EDITOR_DOCUMENT_MAX_BYTES ||
      new TextEncoder().encode(JSON.stringify(input)).length > 256 * 1024
    )
      throw new Error(i18n.t("editor.formatTooLarge"));
    const result = await usePlugins.getState().execute(plugin.id, command.id, () => {
      const current = editorDocument(document.tabId);
      const runtime = usePlugins.getState().items.find((item) => item.id === provider.id);
      if (
        !current ||
        current.documentId !== document.documentId ||
        current.version !== document.version
      )
        throw new Error(i18n.t("editor.documentChanged"));
      if (!runtime || runtime.status !== "running" || runtime.fingerprint !== fingerprint)
        throw new Error(i18n.t("editor.formatRevoked"));
      return input;
    });
    const latest = usePlugins.getState().items.find((item) => item.id === provider.id);
    const security = usePluginSecurity.getState().state;
    if (
      !latest ||
      latest.status !== "running" ||
      latest.fingerprint !== fingerprint ||
      (isTauri() && (security.restricted || !hasPluginGrant(security, latest)))
    )
      throw new Error(i18n.t("editor.formatRevoked"));
    if (
      !result ||
      typeof result !== "object" ||
      !("text" in result) ||
      typeof result.text !== "string"
    )
      throw new Error(i18n.t("editor.invalidFormatResult"));
    if ("error" in result && result.error) throw new Error(result.text);
    if (new TextEncoder().encode(result.text).length > EDITOR_DOCUMENT_MAX_BYTES)
      throw new Error(i18n.t("editor.formatTooLarge"));
    replaceEditorDocument(document, result.text);
    return true;
  } catch (error) {
    const message =
      error instanceof Error && i18n.exists(error.message)
        ? i18n.t(error.message as "editor.documentChanged")
        : translateError(error);
    toast(message, "error");
    return false;
  } finally {
    useFormatting.setState((state) => ({ busy: state.busy.filter((id) => id !== document.tabId) }));
  }
}

export function formatEditorDocument(tabId = useWorkspace.getState().activeId): void {
  const document = tabId ? editorDocument(tabId) : null;
  if (!document) {
    toast(i18n.t("editor.noDocument"), "info");
    return;
  }
  const providers = documentFormatters(document.path, usePlugins.getState().items);
  if (!providers.length) {
    toast(i18n.t("editor.noFormatter"), "info");
    return;
  }
  if (providers.length > 1) useFormatting.setState({ picker: { document, providers } });
  else void runEditorPlugin(providers[0]!, document);
}
