# Errors and diagnostics

Errors cross four boundaries: native IPC, frontend async work, rendering and presentation. They are normalized once at the application boundary, then delivered to every required sink. Do not make a presentation component decide whether a failure is worth logging.

## Error contract

Frontend code uses `AppFailure` from `src/lib/api/errors.ts`:

| Field         | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `code`        | Stable IPC/application category such as `validation`, `ssh`, `internal`.  |
| `message`     | Original code/message from the failing layer; never replaced by UI text.  |
| `userMessage` | Localized title. Specific unknown keys are appended instead of discarded. |
| `severity`    | `debug`, `info`, `warn` or `error`, derived consistently.                 |
| `details`     | Structured IPC details, when present.                                     |
| `stack`       | Frontend stack for JavaScript errors.                                     |

Use `normalizeError` only for pure classification. Use `captureError` for a real failure boundary: it normalizes and writes the structured diagnostic once. Use `notifyError` when the default toast presentation is wanted. A custom surface can use `captureError().userMessage` and render the original through its own control.

`translateError` is retained for older call sites. It still captures the original failure, but new async handlers should call `captureError` or `notifyError` with a domain and operation.

## Severity and sinks

- Cancellation is `debug`; validation, not-found and update failures are `warn`; I/O, SSH, database and internal failures are `error`.
- The same structured event is available to the rotating native log, the Output panel, toast details, inline form state and plugin-facing diagnostics.
- Toast details contain the original code, message, structured details and stack. They are not a second, hand-built error message.
- Global `error` and `unhandledrejection` events are captured so an uncaught frontend failure cannot remain only in the WebView console.
- Logging is best effort. A failed log write is reported once to the console and never recursively logged.
- Credential-like detail values and field names are not copied into log fields by the frontend; the native logger also redacts sensitive keys.

## Native errors

`AppError` serializes its stable IPC payload and logs the original category/message at the transport boundary. Native code should return a stable key, not a user-facing sentence. A frontend generic category may be displayed alongside the key, but the key must never be silently discarded.

Every operation should include a stable domain and operation, for example `hosts/saveEditor`, `panels.windows/drag` or `plugins/install`. Catch blocks must not silently return unless they are an explicitly documented best-effort cleanup path.
