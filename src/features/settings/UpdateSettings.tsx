import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useSettings } from "@/store/settings";
import { matchingUpdateState, updateHistoryKey, useUpdates } from "@/store/updates";
import { toast } from "@/store/toasts";
import { UpdateDiagnostics } from "./UpdateDiagnostics";
import { UpdateNotes } from "./UpdateNotes";
import { UpdateSourceUrlView } from "./components/UpdateSourceUrlView";
import { UpdateStatusView } from "./components/UpdateStatusView";
export { validUpdateSource } from "@/lib/updates/sourceValidation";
export function UpdateSourceUrl({ onReset }: { onReset(): void }) {
  const value = useSettings((s) => s.settings.updateSourceUrl);
  const source = useSettings((s) => s.settings.updateSource);
  const saving = useSettings((s) => s.saving);
  const update = useSettings((s) => s.update);
  const updatesBusy = useUpdates(
    (s) => s.busy || s.state?.phase === "downloading" || s.state?.phase === "ready",
  );
  return <UpdateSourceUrlView {...{ value, source, saving, update, updatesBusy, onReset }} />;
}
export function UpdateStatus() {
  const settings = useSettings((s) => s.settings);
  const version = useSettings((s) => s.info?.version);
  const saving = useSettings((s) => s.saving);
  const state = useUpdates((s) => matchingUpdateState(s.state, settings));
  const busy = useUpdates((s) => s.busy);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const skip = useUpdates((s) => s.skip);
  return (
    <UpdateStatusView
      {...{ settings, version, saving, state, busy }}
      nativeAvailable={isTauri()}
      services={{
        check,
        install,
        skip,
        openRelease: () => {
          void api.openReleasePage().catch((error) => toast(translateError(error), "error"));
        },
        renderDiagnostics: (failures) => <UpdateDiagnostics failures={failures} />,
        renderNotes: (snapshot) => (
          <UpdateNotes key={updateHistoryKey(snapshot)} state={snapshot} />
        ),
      }}
    />
  );
}
