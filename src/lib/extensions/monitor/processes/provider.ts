import type { FrontendProcesses } from "../../contracts/monitor/processes/provider";
import type { CheckProviderAccess } from "../../runtime/providers/access";
import type { ProcessesContext } from "./context";

export function guardProcessesProvider(
  context: ProcessesContext & Pick<FrontendProcesses, "Entries">,
  checkAccess: CheckProviderAccess,
  writable: () => boolean,
): FrontendProcesses {
  const authorize = () => {
    checkAccess();
    if (!writable()) throw new Error("plugin.processes.permissionDenied");
  };
  return Object.freeze({
    Entries: context.Entries,
    snapshot: context.snapshot,
    capabilities: Object.freeze({ terminate: writable() }),
    read(request) {
      checkAccess(false);
      return context.read(request);
    },
    setQuery(query) {
      checkAccess();
      context.setQuery(query);
    },
    setSort(sort) {
      checkAccess();
      context.setSort(sort);
    },
    select(request) {
      checkAccess();
      context.select(request);
    },
    refresh() {
      checkAccess();
      context.refresh();
    },
    setPaused(paused) {
      checkAccess();
      context.setPaused(paused);
    },
    requestTerminate(request) {
      authorize();
      context.requestTerminate(request, authorize);
    },
  } satisfies FrontendProcesses);
}
