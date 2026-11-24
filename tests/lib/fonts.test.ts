import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FontReference } from "@/lib/fonts/types";

const imported: FontReference = { source: "imported", id: "b".repeat(64) };
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let fonts: Set<unknown>;
let fail = false;
let throwInConstructor = false;
const constructed: Array<{ family: string; source: string }> = [];
beforeEach(() => {
  vi.resetModules();
  fail = false;
  throwInConstructor = false;
  fonts = new Set();
  constructed.length = 0;
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  vi.stubGlobal(
    "FontFace",
    class {
      constructor(
        public family: string,
        public source: string,
      ) {
        if (throwInConstructor) throw new TypeError("invalid font");
        constructed.push(this);
      }
      async load() {
        if (fail) throw new Error("bad font");
        return this;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

it("registers an imported face once per document and retires it when deselected", async () => {
  const { ensureFont, activateFonts, selectedFontsReady } = await import("@/lib/fonts/runtime");
  expect(await ensureFont(imported)).toBe(true);
  expect(await ensureFont(imported)).toBe(true);
  expect(fonts.size).toBe(1);
  expect(constructed).toHaveLength(1);
  activateFonts({ ui: imported, mono: imported, editorCjk: null });
  await selectedFontsReady();
  expect(fonts.size).toBe(1);
  activateFonts({ ui: null, mono: null, editorCjk: null });
  await selectedFontsReady();
  expect(fonts.size).toBe(0);
});

it("probes installed font names with escaped local sources and retries failed imports", async () => {
  const { ensureFont, fontSource } = await import("@/lib/fonts/runtime");
  const reference: FontReference = { source: "system", family: 'Local "Name"' };
  expect(fontSource(reference)).toBe('local("Local \\"Name\\"")');
  expect(await ensureFont(reference)).toBe(true);
  expect(fonts.size).toBe(0);
  fail = true;
  expect(await ensureFont(imported)).toBe(false);
  fail = false;
  expect(await ensureFont(imported)).toBe(true);
  expect(fonts.size).toBe(1);
});

it("records a synchronous FontFace failure and allows fallback", async () => {
  const { ensureFont } = await import("@/lib/fonts/runtime");
  const { getLocalDiagnostics } = await import("@/lib/diagnostics");
  throwInConstructor = true;
  await expect(ensureFont(imported)).resolves.toBe(false);
  expect(getLocalDiagnostics()).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ domain: "fonts", operation: "loadSelected", level: "warn" }),
    }),
  ]);
});
