import type { FrontendQuickAccess } from "../../contracts/search/quickAccess/provider";
import type { CheckProviderAccess } from "../../runtime/providers/access";
import type { QuickAccessContext } from "./context";

export function guardQuickAccessProvider(
  context: QuickAccessContext & Pick<FrontendQuickAccess, "Entries">,
  checkAccess: CheckProviderAccess,
  writable: () => boolean,
): FrontendQuickAccess {
  return Object.freeze<FrontendQuickAccess>({
    Entries: context.Entries,
    snapshot: context.snapshot,
    capabilities: Object.freeze({ invoke: writable() }),
    read(request) {
      checkAccess(false);
      return context.read(request);
    },
    setQuery(query) {
      checkAccess();
      context.setQuery(query);
    },
    select(request) {
      checkAccess();
      context.select(request);
    },
    invoke(request) {
      checkAccess();
      if (!writable()) throw new Error("plugin.quickAccess.permissionDenied");
      context.invoke(request);
    },
    close() {
      checkAccess();
      context.close();
    },
  });
}
