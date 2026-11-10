import type { FrontendMonitor } from "../contracts/monitor/provider";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { MonitorContext } from "./context";

export function guardMonitorProvider(
  context: MonitorContext & Pick<FrontendMonitor, "Charts">,
  checkAccess: CheckProviderAccess,
): FrontendMonitor {
  return Object.freeze<FrontendMonitor>({
    Charts: context.Charts,
    snapshot: context.snapshot,
    read: (request) => {
      checkAccess(false);
      return context.read(request);
    },
    refresh: () => {
      checkAccess();
      context.refresh();
    },
  });
}
