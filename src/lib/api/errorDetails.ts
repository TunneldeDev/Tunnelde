import type { DiagnosticEvent } from "@/lib/diagnostics";

/** Bridge only legacy string-based toasts. Explicit notifications carry the
 * event directly rather than trying to match a localized title. */
const pending = new Map<string, { event: DiagnosticEvent; expires: number }>();
const MAX_MESSAGES = 64;
const TTL_MS = 3000;

export function rememberErrorDetails(message: string, event: DiagnosticEvent): void {
  pending.delete(message);
  pending.set(message, { event, expires: Date.now() + TTL_MS });
  while (pending.size > MAX_MESSAGES) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

export function claimErrorDetails(message: string): DiagnosticEvent | undefined {
  const entry = pending.get(message);
  pending.delete(message);
  return entry && entry.expires >= Date.now() ? entry.event : undefined;
}

export function clearErrorDetails(): void {
  pending.clear();
}
