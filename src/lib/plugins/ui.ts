/** Public UI request values are independent of dialog/toast store internals. */
export interface PluginMessage {
  message: string;
  kind: "info" | "success" | "error";
}

function message(params: Record<string, unknown>, limit: number): string {
  const value = params.message;
  // Preserve the existing UTF-16 bounds, including multiline text. The wire's
  // UTF-8 request budget remains a separate host constraint.
  if (typeof value !== "string" || !value || value.length > limit || value.includes("\0"))
    throw new Error("invalid:message");
  return value;
}

export function pluginMessage(params: Record<string, unknown>): PluginMessage {
  const value = message(params, 4000);
  const kind = params.kind ?? "info";
  if (kind !== "info" && kind !== "success" && kind !== "error") throw new Error("invalid:kind");
  return { message: value, kind };
}

export function pluginConfirmation(params: Record<string, unknown>): string {
  return message(params, 220 * 1024);
}
