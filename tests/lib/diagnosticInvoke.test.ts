import { afterEach, expect, it, vi } from "vitest";
import { diagnosticInvoke } from "@/lib/api/diagnosticInvoke";
import { clearLocalDiagnostics, getLocalDiagnostics } from "@/lib/diagnostics";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  invoke.mockReset();
  clearLocalDiagnostics();
});
it("retains panel action, kind, generation and duration without request data", async () => {
  const error = { code: "validation", message: "view state limit" };
  invoke.mockRejectedValue(error);
  await expect(
    diagnosticInvoke("panel_window_control", {
      document: "secret-document",
      request: {
        action: "checkpoint",
        lease: { panelId: "editor-view:private-id", windowId: "main", generation: 7 },
        state: { path: "/private/file", content: "private-content" },
      },
    }),
  ).rejects.toBe(error);
  const event = getLocalDiagnostics()[0]!.event;
  expect(event).toMatchObject({
    operation: "panel_window_control.checkpoint",
    message: "view state limit",
    ipc: {
      command: "panel_window_control",
      action: "checkpoint",
      panelKind: "editor-view",
      generation: 7,
      durationMs: expect.any(Number),
    },
  });
  expect(JSON.stringify(event)).not.toMatch(
    /secret-document|private-id|private\/file|private-content/,
  );
});
it("defers expected staged read rejection to the reader, but logs other expired transfer operations", async () => {
  const error = { code: "validation", message: "transfer expired" };
  invoke.mockRejectedValue(error);
  await expect(
    diagnosticInvoke("panel_window_control", { request: { action: "stagedModel", id: "opaque" } }),
  ).rejects.toBe(error);
  expect(getLocalDiagnostics()).toHaveLength(0);
  await expect(
    diagnosticInvoke("panel_window_control", { request: { action: "acknowledge", id: "opaque" } }),
  ).rejects.toBe(error);
  expect(getLocalDiagnostics()[0]!.event).toMatchObject({
    operation: "panel_window_control.acknowledge",
    message: "transfer expired",
  });
});
it("identifies a plugin command without serializing its input or runtime identity", async () => {
  invoke.mockRejectedValue({ code: "validation", message: "plugin.api.invalidParams" });
  await expect(
    diagnosticInvoke("plugin_run", {
      command: "highlight",
      input: { source: "private source" },
      runtimeId: "private-runtime",
    }),
  ).rejects.toBeDefined();
  expect(getLocalDiagnostics()[0]!.event).toMatchObject({
    operation: "plugin_run.highlight",
    message: "plugin.api.invalidParams",
  });
  expect(JSON.stringify(getLocalDiagnostics())).not.toMatch(/private source|private-runtime/);
});
