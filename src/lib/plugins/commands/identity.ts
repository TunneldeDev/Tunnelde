import type { PluginInfo } from "@/lib/api/types";

export interface PluginActionTarget {
  id: string;
  command?: string;
  view?: string;
}
/** Runtime status can change on activation; the selected package/contribution cannot. */
export function samePluginAction(
  current: PluginInfo | undefined,
  original: PluginInfo,
  action: PluginActionTarget,
): current is PluginInfo {
  if (
    !current ||
    current.id !== original.id ||
    current.version !== original.version ||
    current.fingerprint !== original.fingerprint ||
    current.runtime !== original.runtime
  )
    return false;
  const before = action.command
    ? original.commands.find((c) => c.id === action.command)
    : original.views.find((v) => v.id === action.view && !v.provider);
  const after = action.command
    ? current.commands.find((c) => c.id === action.command)
    : current.views.find((v) => v.id === action.view && !v.provider);
  return !!before && !!after && JSON.stringify(before) === JSON.stringify(after);
}
