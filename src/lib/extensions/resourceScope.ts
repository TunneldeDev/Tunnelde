/** Compatibility entry; private scope implementation is classified by responsibility. */
export type {
  ResourceCleanup,
  ResourceOperationOptions,
  ResourceChildOptions,
  ResourceScope,
} from "./runtime/scopes/contracts";
export { ResourceScopeError, ResourceScopeClosed } from "./runtime/scopes/errors";
export { createResourceScope } from "./runtime/scopes/scope";
