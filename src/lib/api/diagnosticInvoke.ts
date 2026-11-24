import { invoke } from "@tauri-apps/api/core";
import { createDiagnosticSampler, reportError, type IpcDiagnosticContext } from "@/lib/diagnostics";

export function ipcDiagnosticContext(
  command: string,
  args: unknown,
  started: number,
): IpcDiagnosticContext {
  const context: IpcDiagnosticContext = {
    command,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
  if (!args || typeof args !== "object") return context;
  const input = args as Record<string, unknown>;
  const request = input.request;
  if (command === "panel_window_control" && request && typeof request === "object") {
    const row = request as Record<string, unknown>;
    if (typeof row.action === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(row.action))
      context.action = row.action;
    const lease = row.lease as { panelId?: unknown; generation?: unknown } | undefined;
    const panelId = lease?.panelId ?? row.panelId;
    if (typeof panelId === "string") {
      const kind = panelId.split(":", 1)[0]!;
      if (
        [
          "editor-view",
          "host-view",
          "settings-view",
          "terminal",
          "files",
          "sftp",
          "plugin",
          "plugins",
          "hosts",
          "connections",
          "tasks",
          "output",
          "knownHosts",
          "forwarding",
          "filePreview",
        ].includes(kind)
      )
        context.panelKind = kind;
    }
    if (
      typeof lease?.generation === "number" &&
      Number.isSafeInteger(lease.generation) &&
      lease.generation >= 0
    )
      context.generation = lease.generation;
  } else if (
    command === "plugin_run" &&
    typeof input.command === "string" &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(input.command)
  ) {
    context.action = input.command;
  }
  return context;
}

// These commands can repeat on a timer or for each terminal input chunk.
// Avoid a single outage monopolizing the bounded log buffer.
const sampled = new Map(
  [
    "ssh_write",
    "panel_window_terminal",
    "proxy_runtime_list",
    "proxy_connections_list",
    "forwarding_start_pending",
  ].map((command) => [command, createDiagnosticSampler("ipc", command)]),
);

/** Ownership transitions intentionally reject stale panel documents and leases.
 * Preserve the rejection for feature logic without turning it into a generic IPC
 * outage or user-facing diagnostic. */
function expectedPanelLifecycleRejection(command: string, error: unknown, args: unknown) {
  if (command !== "panel_window_control" || !error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  // A commit deletes the transfer before the destination has processed its
  // invalidation. The model reader checks a fresh snapshot and reports genuine
  // failures; do not preempt that check with a generic IPC warning.
  if (
    message === "transfer expired" &&
    args &&
    typeof args === "object" &&
    "request" in args &&
    args.request &&
    typeof args.request === "object" &&
    "action" in args.request &&
    args.request.action === "stagedModel"
  )
    return true;
  return (
    typeof message === "string" &&
    [
      "stale panel owner",
      "stale view checkpoint",
      "panel transfer pending",
      "panel is frozen",
      "panel interaction in progress",
      "coordinator required",
      "panel.window.moveInProgress",
      "panel.viewState.changedDuringCapture",
    ].includes(message)
  );
}

/** Record a command failure before a caller discards or converts the rejection.
 * The diagnostic writer uses the raw Tauri invoke to avoid recursive reporting. */
export async function diagnosticInvoke<T>(
  command: string,
  ...options: Parameters<typeof invoke> extends [string, ...infer P] ? P : never
): Promise<T> {
  const sampler = sampled.get(command);
  const started = performance.now();
  try {
    const value = await invoke<T>(command, ...options);
    sampler?.recovered();
    return value;
  } catch (error) {
    if (expectedPanelLifecycleRejection(command, error, options[0])) throw error;
    // Output samples the read failure as an outage instead of logging per poll.
    if (sampler) sampler.failed(error);
    else if (command !== "logs_output_read") {
      const ipc = ipcDiagnosticContext(command, options[0], started);
      reportError("ipc", ipc.action ? `${command}.${ipc.action}` : command, error, undefined, {
        ipc,
      });
    }
    throw error;
  }
}
