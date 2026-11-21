import { useNavigation } from "@/store/navigation";
import { LogSettingsView } from "./components/LogSettingsView";
export function LogViewer() {
  return <LogSettingsView onShowOutput={() => useNavigation.getState().showOutput()} />;
}
