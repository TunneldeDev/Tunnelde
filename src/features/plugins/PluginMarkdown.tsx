import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { PluginMarkdownView } from "./components/PluginMarkdownView";
const openLink = (url: string) => {
  void api.openExternal(url).catch((error) => toast(translateError(error), "error"));
};
export function PluginMarkdown({ source }: { source: string }) {
  return <PluginMarkdownView source={source} openLink={openLink} />;
}
