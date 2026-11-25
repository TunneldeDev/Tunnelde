import { afterEach, expect, it, vi } from "vitest";
import { mockEnabled } from "@/debugger/contracts";
import { isTauri } from "@/lib/api/ipc";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.__TUNNELDE_DEBUGGER_MOCK__;
});

it("requires development mode, explicit opt-in and a prepared fixture", () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_TUNNELDE_DEBUGGER", "1");
  expect(mockEnabled()).toBe(false);
  window.__TUNNELDE_DEBUGGER_MOCK__ = true;
  expect(mockEnabled()).toBe(true);
  vi.stubEnv("VITE_TUNNELDE_DEBUGGER", "0");
  expect(mockEnabled()).toBe(false);
  vi.stubEnv("VITE_TUNNELDE_DEBUGGER", "1");
  vi.stubEnv("DEV", false);
  expect(mockEnabled()).toBe(false);
});

it("uses mock services in a native fixture and preserves normal native detection", () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_TUNNELDE_DEBUGGER", "1");
  expect(isTauri()).toBe(true);
  window.__TUNNELDE_DEBUGGER_MOCK__ = true;
  expect(isTauri()).toBe(false);
  expect(mockEnabled()).toBe(true);
  vi.stubEnv("DEV", false);
  expect(isTauri()).toBe(true);
  expect(mockEnabled()).toBe(false);
});
