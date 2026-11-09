import { afterEach, expect, it, vi } from "vitest";
import { reportError, writeLog } from "@/lib/diagnostics";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
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
  reportError("events", "ssh:data", new Error("Subscriber failed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("logs_write", {
    entry: expect.objectContaining({
      message: "Subscriber failed",
      domain: "events",
      level: "error",
    }),
  });
});

it("does not copy arbitrary IPC details into log error fields", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  invoke.mockResolvedValue(undefined);
  reportError("events", "plugin://event", {
    code: "ssh",
    message: "Failed",
    details: { password: "secret" },
  });
  expect(invoke).toHaveBeenCalledWith("logs_write", {
    entry: {
      domain: "events",
      operation: "plugin:__event",
      level: "error",
      message: "Failed",
      fields: { code: "ssh" },
    },
  });
});
