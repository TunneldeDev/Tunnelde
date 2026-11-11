import type { FrontendHistory } from "../contracts/history/provider";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { HistoryContext } from "./context";

export function guardHistoryProvider(
  history: HistoryContext & Pick<FrontendHistory, "Entries">,
  checkAccess: CheckProviderAccess,
  permissions: readonly string[],
  currentPermissions: () => readonly string[],
): FrontendHistory {
  const requirePermission = (permission: "history.write" | "ssh.exec") => {
    checkAccess();
    if (!currentPermissions().includes(permission))
      throw new Error("plugin.history.permissionDenied");
  };
  return Object.freeze<FrontendHistory>({
    Entries: history.Entries,
    snapshot: history.snapshot,
    capabilities: Object.freeze({
      delete: permissions.includes("history.write"),
      clear: permissions.includes("history.write"),
      execute: permissions.includes("ssh.exec"),
    }),
    read: (request) => {
      checkAccess(false);
      return history.read(request);
    },
    setQuery: (query) => {
      checkAccess();
      history.setQuery(query);
    },
    refresh: () => {
      checkAccess();
      history.refresh();
    },
    delete: async (id) => {
      requirePermission("history.write");
      await history.delete(id);
    },
    requestClear: () => {
      requirePermission("history.write");
      history.requestClear(() => requirePermission("history.write"));
    },
    execute: async (id) => {
      requirePermission("ssh.exec");
      await history.execute(id);
    },
  });
}
