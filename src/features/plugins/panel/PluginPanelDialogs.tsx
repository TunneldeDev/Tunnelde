import { LocalPluginInstall } from "../LocalPluginInstall";
import { usePluginListDialogs } from "./actions";
/** Main-owned installation drafts outlive the movable plugin list. */
export function PluginPanelDialogs() {
  const request = usePluginListDialogs((s) => s.request);
  return <LocalPluginInstall request={request} />;
}
