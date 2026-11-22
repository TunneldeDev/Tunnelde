/** Short-lived handoff between the error conversion layer and presentation
 * surfaces. It has no store/UI dependency, so inline errors and non-UI callers
 * can normalize/log failures without requiring a mounted notification host. */
const pending = new Map<string, unknown[]>();
const MAX_PER_MESSAGE = 8;
const MAX_MESSAGES = 64;

export function rememberErrorDetails(message: string, error: unknown): void {
  const queue = pending.get(message) ?? [];
  if (queue.length >= MAX_PER_MESSAGE) queue.shift();
  queue.push(error);
  pending.set(message, queue);
  while (pending.size > MAX_MESSAGES) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

export function claimErrorDetails(message: string): unknown | undefined {
  const queue = pending.get(message);
  if (!queue?.length) return undefined;
  const error = queue.shift();
  if (!queue.length) pending.delete(message);
  return error;
}

export function clearErrorDetails(): void {
  pending.clear();
}
