import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import type { UpdateState } from "@/lib/api/types";
import { useUpdates } from "@/store/updates";
import { updateHistoryKey } from "@/lib/updates/stateIdentity";
import { UpdateNotesView } from "./components/UpdateNotesView";
export function UpdateNotes({ state }: { state: UpdateState & { version: string } }) {
  const key = updateHistoryKey(state);
  const history = useUpdates((s) => (s.history?.key === key ? s.history : null));
  const load = useUpdates((s) => s.loadHistory);
  return (
    <UpdateNotesView
      state={state}
      history={history}
      services={{ load, renderMarkdown: (source) => <PluginMarkdown source={source} /> }}
    />
  );
}
