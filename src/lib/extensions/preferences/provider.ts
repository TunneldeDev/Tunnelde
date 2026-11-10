import type { FrontendPreferences } from "../contracts/preferences/provider";
import type { PreferenceSnapshot } from "../contracts/preferences/data/snapshot";
import type { PreferenceSchema } from "../contracts/preferences/data/schema";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { PreferencesContext } from "./context";

function detached<T>(value: T): T {
  const copy: T = structuredClone(value);
  const freeze = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}

export function guardPreferencesProvider(
  context: PreferencesContext & Pick<FrontendPreferences, "Fields">,
  checkAccess: CheckProviderAccess,
  writable: () => boolean,
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
): FrontendPreferences {
  const check = (mutation: boolean) => {
    checkAccess(mutation);
    if (!context.validate(mutation)) throw new Error("plugin.preferences.changed");
  };
  return Object.freeze<FrontendPreferences>({
    Fields: context.Fields,
    snapshot: context.snapshot,
    capabilities: Object.freeze({ update: writable() }),
    async schema() {
      check(false);
      const result = await call<PreferenceSchema>("preferences.schema");
      check(false);
      return detached(result);
    },
    async read() {
      check(false);
      const result = await call<PreferenceSnapshot>("preferences.snapshot");
      check(false);
      return detached(result);
    },
    async update(request) {
      check(true);
      if (!writable()) throw new Error("plugin.preferences.permissionDenied");
      if (
        !request ||
        typeof request.revision !== "string" ||
        !request.changes ||
        typeof request.changes !== "object" ||
        Array.isArray(request.changes)
      )
        throw new Error("plugin.preferences.invalid");
      // Host validation still owns keys, schemas, semantics and persistent CAS.
      const result = await call<PreferenceSnapshot>(
        "preferences.update",
        structuredClone({ ...request }),
      );
      // A successful write changes its own page revision. Fence the provider
      // lease here, not that obsolete frame, and never retry after settlement.
      checkAccess(false);
      return detached(result);
    },
  });
}
