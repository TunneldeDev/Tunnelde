import { copyText } from "@/lib/session/clipboard";
import type { PluginOutput } from "@/store/plugins";
import { PluginCommandResultView } from "./PluginCommandResultView";
export function PluginCommandResult(props: { result: PluginOutput; onClear: () => void }) {
  return <PluginCommandResultView {...props} onCopy={copyText} />;
}
