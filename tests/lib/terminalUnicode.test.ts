import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ITerminalAddon, Terminal as Xterm } from "@xterm/xterm";
import type * as XtermModule from "@xterm/xterm";
import { createTerminalOutputDecoder } from "@/features/terminal/terminalOutput";
import { captureTerminalState, restoreTerminalState } from "@/features/terminal/terminalState";
import type * as SerializeModule from "@xterm/addon-serialize";

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
const serializeModule = { exports: {} as typeof SerializeModule };
runInNewContext(readFileSync(require.resolve("@xterm/addon-serialize"), "utf8"), {
  exports: serializeModule.exports,
  module: serializeModule,
});

// Use the browser path of the actual distributed addon. Its Node Buffer decoder
// ignores byteOffset in its Unicode trie; Tauri's webview has atob and no Buffer.
const browserModule = { exports: {} as { UnicodeGraphemesAddon: new () => ITerminalAddon } };
runInNewContext(readFileSync(require.resolve("@xterm/addon-unicode-graphemes"), "utf8"), {
  exports: browserModule.exports,
  module: browserModule,
  atob,
});

describe("terminal window recreation", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const visible = (terminal: Xterm) => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row)!;
      return Array.from({ length: terminal.cols }, (_, column) => {
        const cell = line.getCell(column)!;
        return [
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColor(),
          cell.getBgColor(),
          cell.isBold(),
        ];
      });
    });
  };

  async function roundtrip(
    terminal: Xterm,
    decode: ReturnType<typeof createTerminalOutputDecoder>,
  ) {
    const addon = new serializeModule.exports.SerializeAddon();
    terminal.loadAddon(addon);
    const parser = decode.checkpoint();
    const state = captureTerminalState(terminal);
    const data = addon.serialize();
    const restored = createTerminal();
    await write(restored, data);
    restoreTerminalState(restored, state);
    if (parser.control) await write(restored, parser.control);
    return { terminal: restored, decode: createTerminalOutputDecoder(parser) };
  }

  it("restores colored Unicode scrollback and continues across every UTF-8/ANSI split", async () => {
    const source = "shell\r\n\x1b[31m中文 👩‍💻\x1b[0m\r\n\x1b[38;2;12;34;56mnext\x1b[0m";
    const all = bytes(source);
    for (let split = 0; split <= all.length; split++) {
      const original = createTerminal();
      let restored: Xterm | undefined;
      const decode = createTerminalOutputDecoder();
      try {
        await write(original, decode(all.subarray(0, split)));
        const next = await roundtrip(original, decode);
        restored = next.terminal;
        await write(original, decode(all.subarray(split)));
        await write(restored, next.decode(all.subarray(split)));
        expect(visible(restored), `split ${split}`).toEqual(visible(original));
        expect(restored.buffer.active.cursorX).toBe(original.buffer.active.cursorX);
        expect(restored.buffer.active.cursorY).toBe(original.buffer.active.cursorY);
      } finally {
        original.dispose();
        restored?.dispose();
      }
    }
  });

  it("keeps alternate screen, scroll margins, saved cursor, DEC character sets and mouse/paste modes", async () => {
    const original = createTerminal();
    let restored: Xterm | undefined;
    const decode = createTerminalOutputDecoder();
    try {
      await write(
        original,
        decode(
          bytes(
            "shell prompt\r\n\x1b[?1049h\x1b[2J\x1b[2;10r\x1b[?6h\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[3;5H\x1b[32m\x1b7\x1b(0lqqk\x1b[5;2H",
          ),
        ),
      );
      const next = await roundtrip(original, decode);
      restored = next.terminal;
      expect(visible(restored)).toEqual(visible(original));
      expect(restored.modes).toEqual(original.modes);
      const more = "\x1b8x\r\nxx\x1b(B\x1b[10;1Hlast\r\nscroll";
      await write(original, decode(bytes(more)));
      await write(restored, next.decode(bytes(more)));
      expect(visible(restored)).toEqual(visible(original));
      await write(original, "\x1b[?1049l");
      await write(restored, "\x1b[?1049l");
      expect(visible(restored)).toEqual(visible(original));
      expect(restored.buffer.active.cursorX).toBe(original.buffer.active.cursorX);
      expect(restored.buffer.active.cursorY).toBe(original.buffer.active.cursorY);
    } finally {
      original.dispose();
      restored?.dispose();
    }
  });

  it("preserves split OSC strings and rejects an oversized unfinished control without dropping it", () => {
    const decode = createTerminalOutputDecoder();
    decode(bytes("\x1b]0;window title\x1b"));
    expect(decode.checkpoint().control).toBe("\x1b]0;window title\x1b");
    const resumed = createTerminalOutputDecoder(decode.checkpoint());
    resumed(bytes("\\text"));
    expect(resumed.checkpoint().control).toBe("");
    resumed(bytes("\x1b]0;" + "x".repeat(65537)));
    expect(() => resumed.checkpoint()).toThrow("terminal.checkpointBusy");
    resumed(bytes("\x07"));
    expect(resumed.checkpoint().control).toBe("");
  });

  it.each([
    [0xf0, 0x80],
    [0xed, 0xa0],
    [0xe0, 0x80],
    [0xf4, 0x90],
  ])("does not replay an already rejected UTF-8 prefix %j", (...prefix: number[]) => {
    const decode = createTerminalOutputDecoder();
    decode(new Uint8Array(prefix));
    expect(decode.checkpoint().utf8).toEqual([]);
  });
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
