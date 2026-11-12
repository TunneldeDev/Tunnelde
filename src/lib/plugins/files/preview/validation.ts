const encoder = new TextEncoder();
export const invalid = () => new Error("plugin.filePreview.invalid");
export function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    )
  )
    throw invalid();
  return value as Record<string, unknown>;
}
export function budget<T>(value: T, maximum: number): T {
  if (encoder.encode(JSON.stringify(value)).length > maximum) throw invalid();
  return value;
}
export function token(value: unknown, maximum = 128): string {
  if (
    typeof value !== "string" ||
    !value ||
    encoder.encode(value).length > maximum ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  )
    throw invalid();
  return value;
}
export function integer(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw invalid();
  return value as number;
}
export function path(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    encoder.encode(value).length > 32768 ||
    /[\0\p{Cs}]/u.test(value)
  )
    throw invalid();
  return value;
}
