import type { UpdateSourceFailure } from "@/lib/api/types";
import { useNavigation } from "@/store/navigation";
import { UpdateDiagnosticsView } from "./components/UpdateDiagnosticsView";
export function UpdateDiagnostics({ failures }: { failures: UpdateSourceFailure[] }) {
  return (
    <UpdateDiagnosticsView
      failures={failures}
      onConfigureProxy={() => useNavigation.getState().selectSettings("network")}
      onShowLogs={() => useNavigation.getState().showOutput()}
    />
  );
}
