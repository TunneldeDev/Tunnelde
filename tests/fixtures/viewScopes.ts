import { vi } from "vitest";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { createResourceScope } from "@/lib/extensions/resourceScope";

/** Presentation unit tests mock module loading; runtime admission has real integration tests. */
export function mockCommittedViewScopes() {
  const root = createResourceScope();
  vi.spyOn(frontendRuntime, "viewScope").mockImplementation(() => root.child());
  return root;
}
