import type { FileEntry, FsSource, PluginInfo } from "@/lib/api/types";
import { useSsh } from "@/store/ssh";
import { runPluginContextCommand, type PluginContextCommand } from "./contextCommand";
import i18n from "@/i18n/i18n";

export type FileMenuContribution = PluginContextCommand;

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

/** Bind a menu click to the selected entry; shared dispatch rechecks consent and identity. */
export function runFileMenuCommand(
  action: FileMenuContribution,
  source: FsSource,
  entry: FileEntry,
): Promise<void> {
  return runPluginContextCommand(action, {
    accepts: (plugin) =>
      fileMenuCommands([plugin], source, entry).some((item) => item.command === action.command),
    validate: () => {
      if (
        source.kind === "remote" &&
        !useSsh.getState().sessions.some((item) => item.id === source.sessionId)
      )
        throw new Error(i18n.t("ssh.sessionMissing"));
    },
    input: () => ({
      file: { path: entry.path, name: entry.name, isDirectory: entry.isDir, source },
    }),
  });
}
