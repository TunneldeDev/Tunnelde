import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ITerminalAddon, Terminal as Xterm } from "@xterm/xterm";
import type * as XtermModule from "@xterm/xterm";
import { createTerminalOutputDecoder } from "@/features/terminal/terminalOutput";

const require = createRequire(import.meta.url);
// The buffer/parser can run without a DOM; isolate its browser rendering helpers
// so jsdom never needs to emulate a canvas just to test character cells.
const xtermModule = { exports: {} as typeof XtermModule };
runInNewContext(readFileSync(require.resolve("@xterm/xterm"), "utf8"), {
  exports: xtermModule.exports,
  module: xtermModule,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  performance,
  process,
});
const { Terminal } = xtermModule.exports;

// Use the browser path of the actual distributed addon. Its Node Buffer decoder
// ignores byteOffset in its Unicode trie; Tauri's webview has atob and no Buffer.
const browserModule = { exports: {} as { UnicodeGraphemesAddon: new () => ITerminalAddon } };
runInNewContext(readFileSync(require.resolve("@xterm/addon-unicode-graphemes"), "utf8"), {
  exports: browserModule.exports,
  module: browserModule,
  atob,
});

function createTerminal(modern = true) {
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 12 });
  if (modern) terminal.loadAddon(new browserModule.exports.UnicodeGraphemesAddon());
  return terminal;
}

function write(terminal: Xterm, data: string | Uint8Array) {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

describe("terminal Unicode cell layout", () => {
  it("keeps mixed Chinese, circled numbers and emoji borders in the same column", async () => {
    const terminal = createTerminal();
    const sample = [
      "┌────────────────────────┐",
      "│ plain ASCII            │",
      "│ 中文  ①  \x1b[31m❌\x1b[0m ✅ 👩‍💻      │",
      "│ 👨‍👩‍👧‍👦 🇨🇳 👍🏽 ❤️ 1️⃣         │",
      "└────────────────────────┘",
    ].join("\r\n");
    try {
      await write(terminal, sample);
      for (let row = 0; row < 5; row++) {
        const line = terminal.buffer.active.getLine(row)!;
        expect(line.getCell(25)?.getChars()).toBe(["┐", "│", "│", "│", "┘"][row]);
        expect(line.getCell(26)?.getChars()).toBe("");
      }
      const legacy = createTerminal(false);
      try {
        await write(legacy, sample);
        expect(legacy.buffer.active.getLine(2)?.getCell(25)?.getChars()).not.toBe("│");
      } finally {
        legacy.dispose();
      }
    } finally {
      terminal.dispose();
    }
  });

  it.each([
    ["中文", 4],
    ["①②③④", 4],
    ["❌", 2],
    ["✅", 2],
    ["🚀", 2],
    ["👩‍💻", 2],
    ["👨‍👩‍👧‍👦", 2],
    ["🇨🇳", 2],
    ["👍🏽", 2],
    ["❤️", 2],
    ["1️⃣", 2],
    ["e\u0301", 1],
  ])("measures %s as %i columns", async (sample, width) => {
    const terminal = createTerminal();
    try {
      await write(terminal, sample);
      expect(terminal.buffer.active.cursorX).toBe(width);
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(sample);
      if (width <= 2)
        expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe(sample);
    } finally {
      terminal.dispose();
    }
  });

  it("preserves graphemes and cell positions when SSH splits every UTF-8 byte", async () => {
    const terminal = createTerminal();
    const sample = "│👩‍💻🇨🇳e\u0301❌│";
    const decode = createTerminalOutputDecoder();
    try {
      for (const byte of new TextEncoder().encode(sample)) {
        const text = decode(Uint8Array.of(byte));
        if (text) await write(terminal, text);
      }
      const line = terminal.buffer.active.getLine(0)!;
      expect(terminal.buffer.active.cursorX).toBe(9);
      expect(line.translateToString(true)).toBe(sample);
      expect(line.getCell(1)?.getChars()).toBe("👩‍💻");
      expect(line.getCell(3)?.getChars()).toBe("🇨🇳");
      expect(line.getCell(5)?.getChars()).toBe("e\u0301");
      expect(line.getCell(6)?.getChars()).toBe("❌");
      expect(line.getCell(8)?.getChars()).toBe("│");
    } finally {
      terminal.dispose();
    }
  });
});
