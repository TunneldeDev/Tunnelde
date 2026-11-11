export class ResourceScopeError extends Error {
  constructor(
    readonly code:
      "extension.scope.closed" | "extension.scope.cancelled" | "extension.scope.timeout",
  ) {
    super(code);
    this.name = "ResourceScopeError";
  }
}

export class ResourceScopeClosed extends ResourceScopeError {
  constructor() {
    super("extension.scope.closed");
    this.name = "ResourceScopeClosed";
  }
}
