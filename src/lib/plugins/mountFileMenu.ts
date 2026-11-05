import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { hasPluginGrant, usePluginSecurity } from "@/store/pluginSecurity";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";

/** Information returned by the owning plugin's authorized mounts.list call. */
export interface MountedDirectory {
  id: string;
  sessionId: string;
  remotePath: string;
  mountPoint: string;
  cleanupError?: string | null;
}

/** Select the most specific live mount in this SSH session for an explicit item. */
export function selectMountedDirectory(
  mounts: readonly MountedDirectory[],
  sessionId: string,
  path: string,
): MountedDirectory | undefined {
  const components = (value: string): string[] | null => {
    if (!value.startsWith("/") || value.includes("\0")) return null;
    const parts = value.split("/").filter(Boolean);
    return parts.some((part) => part === "." || part === "..") ? null : parts;
  };
  const target = components(path);
  if (!target) return undefined;
  let result: MountedDirectory | undefined;
  let depth = -1;
  for (const mount of mounts) {
    if (mount.sessionId !== sessionId || mount.cleanupError) continue;
    const root = components(mount.remotePath);
    if (!root || root.length <= depth || root.length > target.length) continue;
    if (!root.every((part, index) => target[index] === part)) continue;
    result = mount;
    depth = root.length;
  }
  return result;
}
export interface MountedFileAction {
  pluginId: string;
  pluginName: string;
  fingerprint: string | undefined;
  mount: MountedDirectory;
}

/** Query only already-authorized mount owners; never prompt just for opening a menu. */
export async function discoverMountedFileActions(
  sessionId: string,
  path: string,
  onAction?: (action: MountedFileAction) => void,
): Promise<MountedFileAction[]> {
  if (!isTauri()) return [];
  const security = usePluginSecurity.getState().state;
  if (
    security.restricted ||
    !useSsh.getState().sessions.some((session) => session.id === sessionId)
  )
    return [];
  const plugins = usePlugins
    .getState()
    .items.filter(
      (plugin) =>
        plugin.mountedFileReveal === true &&
        plugin.permissions.includes("mounts.read") &&
        plugin.permissions.includes("mounts.write") &&
        hasPluginGrant(security, plugin),
    );
  const actions = await Promise.all(
    plugins.map(async (plugin) => {
      try {
        const mounts = await invoke<MountedDirectory[]>("plugin_mounts_action", {
          pluginId: plugin.id,
          method: "list",
          params: {},
        });
        const mount = selectMountedDirectory(mounts, sessionId, path);
        const latest = usePlugins.getState().items.find((item) => item.id === plugin.id);
        const current = usePluginSecurity.getState().state;
        if (
          !mount ||
          !latest ||
          latest.mountedFileReveal !== true ||
          latest.fingerprint !== plugin.fingerprint ||
          current.restricted ||
          !hasPluginGrant(current, latest) ||
          !useSsh.getState().sessions.some((session) => session.id === sessionId)
        )
          return null;
        const action = {
          pluginId: plugin.id,
          pluginName: plugin.name,
          fingerprint: plugin.fingerprint,
          mount,
        };
        onAction?.(action);
        return action;
      } catch {
        return null;
      }
    }),
  );
  return actions.filter((action): action is MountedFileAction => action !== null);
}

export async function revealMountedFile(
  action: MountedFileAction,
  sessionId: string,
  path: string,
): Promise<void> {
  try {
    const plugin = usePlugins.getState().items.find((item) => item.id === action.pluginId);
    const security = usePluginSecurity.getState().state;
    if (
      !plugin ||
      plugin.mountedFileReveal !== true ||
      plugin.fingerprint !== action.fingerprint ||
      security.restricted ||
      !hasPluginGrant(security, plugin) ||
      !useSsh.getState().sessions.some((session) => session.id === sessionId)
    ) {
      toast(i18n.t("mounts.actionUnavailable"), "error");
      return;
    }
    await invoke("plugin_mounts_action", {
      pluginId: action.pluginId,
      method: "reveal",
      params: { id: action.mount.id, sessionId, path },
    });
  } catch (error) {
    toast(translateError(error), "error");
  }
}
