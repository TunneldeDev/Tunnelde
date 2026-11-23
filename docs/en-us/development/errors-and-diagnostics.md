# Errors and diagnostics

Capture errors at the layer that owns the failure. Translation, logging, and notification are
separate: translating an error must never change logging state.

## Frontend boundaries

- `normalizeError` classifies an error and `translateError` supplies localized UI text. Neither
  writes a log. The normalized object may include the original message, details, or stack for a
  purpose-specific UI; do not log or copy that object wholesale.
- `reportError(domain, operation, error)` records a failure even without a UI.
  `captureError` returns the classification and the safe diagnostic. `notifyError` attaches that
  diagnostic directly to a toast. `presentError` is a bridge for existing string-based surfaces.
- Route application commands through `diagnosticInvoke`. It observes rejections before a
  caller converts or discards them. It records the command name, not the arguments, and
  rethrows the original error. Do not use it for the diagnostic transport itself.
- Register render boundaries around independently recoverable views. Leave navigation and input
  outside the failure boundary when possible. For a staged panel, propagate the failure to the
  owner so it can reject the move instead of accepting a broken view.
- Global WebView and React handlers report uncaught errors. For a repeatedly failing background
  read or write, use an outage sampler so the first failure is recorded and repeated attempts
  do not crowd out unrelated diagnostics.

## Native boundaries

`AppError` serialization only implements the existing wire format. Native operations that
intentionally consume an error (background updates, lifecycle cleanup, native window handling,
and event delivery) should call `diagnostics::failure::native` or `observe_tauri` at that point.
Use fixed domain/operation labels. Do not put external error text, paths, IDs from payloads,
SSH data, or command arguments in those labels. Returning an error to an observed IPC boundary
does not require logging it again in Rust.

For ignored results, distinguish expected cancellation/disposal, queue tails whose returned
promises are already observed, and idempotent cleanup from actual failures of owned resources.
Do not hide a failed rollback or replace a retryable error with success. Log incomplete rollback
separately from the original failure without changing the ownership or retry decision.

## Sinks and privacy

Structured failure records carry an event ID, time, severity, stable operation and category,
an allowlisted label, and optional application-relative source coordinates. Arbitrary exception
messages, original IPC payloads, terminal input, personal file paths and raw stacks are omitted.
Expected aborts are debug-level; I/O, runtime, database, and SSH failures normally use error.

The diagnostic command does not grant access to general logging or log reads. Log writes are
best-effort and obey the local tracing filter; a response is not a durability acknowledgement.
A bounded rolling buffer keeps recent failures available when the directory, writer, or IPC is
unavailable. Output merges matching records by event ID and prefers the disk copy. A
diagnostic write failure must never recursively attempt the same write. See the
[logging guide](../guide/logging.md) for user-facing troubleshooting and retention.
