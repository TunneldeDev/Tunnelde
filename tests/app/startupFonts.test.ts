import { afterEach, describe, expect, it, vi } from "vitest";

import { loadStartupFonts } from "@/app/startupFonts";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.removeProperty("font-family");
  document.documentElement.style.removeProperty("--td-mono");
  // jsdom has no font loading API; each test supplies its own.
  Reflect.deleteProperty(document, "fonts");
});

describe("startup fonts", () => {
  it("waits for the selected UI and mono fonts and avoids loading unused fallback families", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const load = vi.fn().mockReturnValue(pending);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    document.body.style.fontFamily = '"IBM Plex Sans", sans-serif';
    document.documentElement.style.setProperty(
      "--td-mono",
      '"JetBrains Mono", "Fira Code", monospace',
    );
    const finished = vi.fn();
    const ready = loadStartupFonts().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    expect(load.mock.calls.map(([font]) => font)).toEqual([
      '400 14px "IBM Plex Sans"',
      '500 14px "IBM Plex Sans"',
      '600 14px "IBM Plex Sans"',
      '400 14px "JetBrains Mono"',
      '500 14px "JetBrains Mono"',
    ]);
    resolve();
    await ready;
    expect(finished).toHaveBeenCalledOnce();
  });

  it("allows font fallback when a bundled face fails to load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    document.body.style.fontFamily = '"IBM Plex Sans"';
    const load = vi.fn().mockRejectedValue(new Error("font failed"));
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    await expect(loadStartupFonts()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
