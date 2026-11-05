import type { FileEntry, FsSource, PluginInfo } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { isTauri } from "@/lib/api/ipc";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { useWorkspace } from "@/store/workspace";
import { normalizeResult } from "@/lib/plugins/pluginView";
import i18n from "@/i18n/i18n";

export interface FileMenuContribution {
  pluginId: string;
  pluginName: string;
  command: string;
  title: string;
  fingerprint?: string;
  first: boolean;
}

export function fileMenuCommands(
  plugins: readonly PluginInfo[],
  source: FsSource,
  entry: FileEntry,
): FileMenuContribution[] {
  const result: FileMenuContribution[] = [];
  for (const plugin of plugins) {
    if (plugin.runtime === "theme" || plugin.runtime === "declarative") continue;
    for (const command of plugin.commands) {
      const menu = command.fileMenu;
      const permission = source.kind === "local" ? "fs.read" : "sftp.read";
      if (
        !menu ||
        !plugin.permissions.includes(permission) ||
        !menu.sources.includes(source.kind) ||
        !menu.kinds.includes(entry.isDir ? "directory" : "file")
      )
        continue;
      if (
        !entry.isDir &&
        menu.extensions?.length &&
        !menu.extensions.some((extension) =>
          entry.name.toLowerCase().endsWith(`.${extension.toLowerCase()}`),
        )
      )
        continue;
      result.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        command: command.id,
        title: command.title,
        fingerprint: plugin.fingerprint,
        first: result.length === 0,
      });
    }
  }
  return result;
}

/** Bind a menu click to the selected entry and recheck the plugin after any consent prompt. */
export async function runFileMenuCommand(
  action: FileMenuContribution,
  source: FsSource,
  entry: FileEntry,
): Promise<void> {
  try {
    const original = usePlugins.getState().items.find((item) => item.id === action.pluginId);
    if (
      !original ||
      original.fingerprint !== action.fingerprint ||
      !fileMenuCommands([original], source, entry).some((item) => item.command === action.command)
    )
      throw new Error(i18n.t("pluginSecurity.changed"));
    if (
      source.kind === "remote" &&
      !useSsh.getState().sessions.some((item) => item.id === source.sessionId)
    )
      throw new Error(i18n.t("ssh.sessionMissing"));
    if (original.status !== "running") await usePlugins.getState().start(original.id);
    const current = usePlugins.getState().items.find((item) => item.id === action.pluginId);
    if (
      !current ||
      current.fingerprint !== action.fingerprint ||
      !fileMenuCommands([current], source, entry).some((item) => item.command === action.command)
    )
      throw new Error(i18n.t("pluginSecurity.changed"));
    // A declined permission or runtime prompt intentionally leaves the plugin stopped.
    // start() already reports actual launch failures; do not add a misleading error.
    if (current.status !== "running") return;
    const result = await usePlugins.getState().execute(current.id, action.command, () => {
      const latest = usePlugins.getState().items.find((item) => item.id === action.pluginId);
      if (
        !latest ||
        latest.fingerprint !== action.fingerprint ||
        !fileMenuCommands([latest], source, entry).some((item) => item.command === action.command)
      )
        throw new Error(i18n.t("pluginSecurity.changed"));
      if (
        source.kind === "remote" &&
        !useSsh.getState().sessions.some((item) => item.id === source.sessionId)
      )
        throw new Error(i18n.t("ssh.sessionMissing"));
      return { file: { path: entry.path, name: entry.name, isDirectory: entry.isDir, source } };
    });
    const latest = usePlugins.getState().items.find((item) => item.id === action.pluginId);
    const security = usePluginSecurity.getState().state;
    if (
      !latest ||
      latest.status !== "running" ||
      latest.fingerprint !== action.fingerprint ||
      (isTauri() && (security.restricted || !hasPluginGrant(security, latest)))
    )
      return;
    if (
      result &&
      typeof result === "object" &&
      "text" in result &&
      typeof result.text === "string"
    ) {
      const output = normalizeResult(result);
      usePlugins.setState((state) => ({
        outputs: {
          ...state.outputs,
          [current.id]: {
            text: output.text,
            error: output.error,
          },
        },
      }));
      useWorkspace.getState().openPluginView(current.id, "$command", current.name);
    }
  } catch (error) {
    // Declining an explicit authorization prompt is a cancellation, not a failure.
    if (error instanceof Error && error.message === "plugin.permissionDenied") return;
    toast(
      error instanceof Error && error.message === "resultTooLarge"
        ? i18n.t("pluginView.resultTooLarge")
        : translateError(error),
      "error",
    );
  }
}
