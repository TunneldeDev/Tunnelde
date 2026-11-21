import { copyText } from "@/lib/session/clipboard";
import { PluginErrorView } from "./components/PluginErrorView";
export function PluginError({ message }: { message: string }) {
  return <PluginErrorView message={message} onCopy={copyText} />;
}
