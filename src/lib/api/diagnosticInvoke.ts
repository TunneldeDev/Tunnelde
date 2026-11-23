import { invoke } from "@tauri-apps/api/core";
import { createDiagnosticSampler, reportError } from "@/lib/diagnostics";

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

/** Record a command failure before a caller discards or converts the rejection.
 * The diagnostic writer uses the raw Tauri invoke to avoid recursive reporting. */
export async function diagnosticInvoke<T>(
  command: string,
  ...options: Parameters<typeof invoke> extends [string, ...infer P] ? P : never
): Promise<T> {
  const sampler = sampled.get(command);
  try {
    const value = await invoke<T>(command, ...options);
    sampler?.recovered();
    return value;
  } catch (error) {
    // Output samples the read failure as an outage instead of logging per poll.
    if (sampler) sampler.failed(error);
    else if (command !== "logs_output_read") reportError("ipc", command, error);
    throw error;
  }
}
