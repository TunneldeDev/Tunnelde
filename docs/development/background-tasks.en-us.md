# Background tasks

[简体中文](background-tasks.zh-cn.md)

The workbench task service separates execution, reporting and presentation. A feature can
publish work in the shared, movable task window without depending on file management.
The status-bar entry and the F1 **Background tasks** command open the same window.
Tasks never open it automatically. Groups load twenty rows at a time; completed work
starts collapsed. A task may set `visible: false` to keep it out of this UI.

The task button highlights active work and shows progress, or an indeterminate indicator
when totals are unknown. The fixed toolbar clears all removable finished records across
collapsed groups and pages, including failures with a `clear` action. Running, paused,
hidden and recovery-only tasks are retained. Clearing uses at most four concurrent source
actions and waits for completion; one failed action does not stop the remaining records.

## Wrap asynchronous work

```ts
import { runBackgroundTask, withBackgroundTask } from "@/lib/tasks/background";

const result = await runBackgroundTask({ title: "Build index" }, async ({ signal, report }) => {
  for (let index = 0; index < documents.length; index++) {
    signal.throwIfAborted();
    await indexDocument(documents[index], signal);
    report({ progress: { completed: index + 1, total: documents.length, unit: "items" } });
  }
  return documents.length;
});

const refresh = withBackgroundTask(
  (folder: string) => ({ title: `Refresh ${folder}`, visible: false, cancellable: false }),
  async ({ signal }, folder) => refreshFolder(folder, signal),
);
```

The wrapper preserves the return value and rejection. Reports may contain a message and
progress in bytes, items or percent. Omit the total for indeterminate progress. Cancellation
is cooperative: the Cancel action aborts the signal, but the task remains running until
the operation settles. Check the signal and release resources in `finally`. An operation
that succeeds after a late cancellation is recorded as completed; unrelated errors remain
failures. A parent AbortSignal is supported. `cancellable: false` hides the Cancel action.

These functions do not move CPU work to a worker or create a native process. Frontend work,
including hidden tasks, defers tray WebView suspension until it settles. The history of the
most recent hundred settled wrapper tasks survives WebView recreation in native memory;
it does not survive application exit. Invisible wrapper tasks are removed when settled.

## Connect an existing task service

Use `registerBackgroundTaskSource` for work whose execution and persistence already belong
to a feature. A source supplies a snapshot and a subscription and returns one disposer:

```ts
const dispose = registerBackgroundTaskSource(
  {
    id: "indexer",
    snapshot: () =>
      jobs.map((job) => ({
        id: job.id,
        title: job.title,
        status: job.status,
        execution: "native",
        updatedAt: job.updatedAt,
        visible: job.showInTaskWindow,
        progress: { completed: job.processed, total: job.total, unit: "items" },
        actions: [{ id: "cancel", label: "Cancel indexing", run: () => cancelJob(job.id) }],
      })),
    subscribe: (changed) => jobEvents.subscribe(changed),
  },
  lifetime.signal,
);
```

Source IDs must be unique. IDs inside different sources may overlap. A disposer and its
AbortSignal remove subscriptions and rows without cancelling underlying work. Register and
dispose sources with the application lifecycle; reconnect subscriptions and reconcile an
authoritative snapshot after WebView recreation. Registration subscribes before reading its
final snapshot, preventing an event gap. Old disposers cannot remove newer registrations.

Statuses are `running`, `paused`, `attention`, `done` and `cancelled`. Use `attention` for
failures or pending recovery. Actions have an ID, accessible label, enabled state and handler.
Only advertise operations the source supports. A `clear` action on settled tasks participates
in bulk clearing. Source-owned tasks are never discarded automatically by the task service.

`execution: "native"` means the actual operation survives destruction of this WebView and
the source can reconstruct its state afterwards. Use `webview` otherwise, even when the
operation calls native IPC but still relies on a JavaScript continuation to complete.

The default row supports messages, progress, errors and actions. Features needing richer
controls register a presentation with `registerTaskPresentation` from
`src/features/tasks/presentation.ts`. Pair both registrations and dispose them together.
The file-transfer adapter owns reconnect, resume, speed limits and temporary-file cleanup;
the common task window owns grouping, pagination, focus and geometry.

This is a workbench integration API. It does not grant a plugin additional permissions or
change the plugin protocol version. External plugin API stability is documented separately.
