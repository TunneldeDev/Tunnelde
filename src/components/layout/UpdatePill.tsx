import { ArrowUpCircle } from "lucide-react";

import { matchingUpdateState, useUpdates } from "@/store/updates";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

/** Shown in the status bar while a newer release is waiting. */
export function UpdatePill() {
  const settings = useSettings((value) => value.settings);
  const state = useUpdates((value) => matchingUpdateState(value.state, settings));
  const openPage = useWorkspace((value) => value.openPage);

  if (!state?.available || state.skipped || !state.version) {
    return null;
  }

  return (
    <button type="button" className="td-update-pill" onClick={() => openPage("updates")}>
      <ArrowUpCircle size={12} />
      <span>{state.version}</span>
    </button>
  );
}
