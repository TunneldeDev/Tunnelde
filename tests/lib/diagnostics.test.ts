import { afterEach, expect, it, vi } from "vitest";
import {
  clearLocalDiagnostics,
  getLocalDiagnostics,
  reportError,
  writeLog,
} from "@/lib/diagnostics";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  clearLocalDiagnostics();
  vi.resetAllMocks();
});

it("routes frontend diagnostics to native disk logging with domain and correlation", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  invoke.mockResolvedValue(undefined);
  await writeLog("ssh", {
    message: "Failed",
    level: "error",
    operation: "connect",
    requestId: "id",
    fields: { attempt: 2 },
  });
  expect(invoke).toHaveBeenCalledWith("logs_write", {
    entry: {
      domain: "ssh",
      message: "Failed",
      level: "error",
      operation: "connect",
      requestId: "id",
      fields: { attempt: 2 },
    },
  });
});

it("keeps browser-only views working and avoids recursive failures", async () => {
  await writeLog("test", { message: "Browser preview" });
  expect(invoke).not.toHaveBeenCalled();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  invoke.mockRejectedValue(new Error("Disk unavailable"));
  const event = reportError("events", "ssh:data", new Error("Subscriber failed"));
  await vi.waitFor(() =>
    expect(getLocalDiagnostics()).toContainEqual({ event, delivery: "memory" }),
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith("diagnostics_report", { event });
});

it("does not copy arbitrary IPC details into log error fields", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  invoke.mockResolvedValue(true);
  const failure = Object.assign(new Error("Failed to reach secret.example with password=abc"), {
    code: "ssh",
    details: { password: "secret", query: "do-not-persist" },
    stack:
      "Error: secret.example src/secret.ts:1:1\n    at run (http://localhost/src/App.tsx?token=secret:42:1)\n" +
      "    at remote (https://private.example/src/file.ts:19:2)\n" +
      "    at local (/Users/private/src/secret.ts:19:2)",
  });
  const event = reportError("events", "plugin://event", failure, "error", { requestId: "req-123" });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(event).toMatchObject({
    domain: "events",
    operation: "plugin:__event",
    level: "error",
    code: "ssh",
    requestId: "req-123",
    frames: ["src/App.tsx:42:1"],
  });
  expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/secret|do-not-persist|private.example/);
  expect(reportError("events", "outer", failure).eventId).toBe(event.eventId);
  expect(reportError("events", "outer", new Error(failure.message)).eventId).not.toBe(
    event.eventId,
  );
});
