/** Accept cross-realm AbortSignals without relying on instanceof. */
export function validateScopeSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw new TypeError("extension.scope.invalidSignal");
}
