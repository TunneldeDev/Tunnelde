import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

// Node 26's experimental localStorage global can shadow jsdom's native
// Storage getter before setup runs. jsdom retains the real implementation on
// `_localStorage`; expose that exact instance so Storage.prototype spies work.
if (typeof window !== "undefined") {
  const nativeStorage = (window as Window & { _localStorage?: Storage })._localStorage;
  if (nativeStorage) {
    Object.defineProperty(window, "localStorage", {
      value: nativeStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: nativeStorage,
      writable: true,
      configurable: true,
    });
  }
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
