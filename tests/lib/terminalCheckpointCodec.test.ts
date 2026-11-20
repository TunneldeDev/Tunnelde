import { describe, expect, it } from "vitest";
import {
  encodeTerminalCheckpoint,
  decodeTerminalCheckpoint,
} from "@/features/terminal/terminalCheckpointCodec";
import { parsePanelViewCapsule } from "@/lib/panels/viewState";
import { terminalCheckpointFixture } from "../fixtures/terminalCheckpoint";

const fixture = terminalCheckpointFixture;
const wire = () => encodeTerminalCheckpoint(fixture());
describe("private terminal checkpoint JSON transport", () => {
  it("preserves undefined charsets, tab stops, modes, keyboard stacks and partial input/output", () => {
    const original = fixture();
    const encoded = wire();
    expect(encoded.state.charset.charset).toBeNull();
    expect(encoded.state.buffers.normal.savedCharset).toBeNull();
    expect(encoded.state.charset._charsets[0]).toBeNull();
    const capsule = parsePanelViewCapsule({ version: 1, fields: { terminal: encoded } });
    const restored = decodeTerminalCheckpoint(capsule.fields.terminal);
    expect(restored).toStrictEqual(original);
    restored.state.kittyKeyboard!.mainStack.push(99);
    restored.state.buffers.normal.tabs[8] = false;
    expect(original.state.kittyKeyboard!.mainStack).toEqual([0, 1]);
    expect(encoded.state.buffers.normal.tabs[8]).toBe(true);
  });
  it("preserves optional keyboard state without injecting an undefined wire property", () => {
    const checkpoint = fixture();
    delete checkpoint.state.kittyKeyboard;
    expect(decodeTerminalCheckpoint(encodeTerminalCheckpoint(checkpoint))).toStrictEqual(
      checkpoint,
    );
  });
  it("materializes sparse charset slots as undefined instead of leaking JSON nulls to xterm", () => {
    const checkpoint = fixture();
    checkpoint.state.charset._charsets = new Array(4);
    expect(
      decodeTerminalCheckpoint(encodeTerminalCheckpoint(checkpoint)).state.charset._charsets,
    ).toStrictEqual([undefined, undefined, undefined, undefined]);
  });
  it.each([
    [
      "unknown version",
      (value: ReturnType<typeof wire>) => {
        value.version = 2 as 1;
      },
    ],
    [
      "fractional sequence",
      (value: ReturnType<typeof wire>) => {
        value.sequence = 1.5;
      },
    ],
    [
      "negative sequence",
      (value: ReturnType<typeof wire>) => {
        value.sequence = -1;
      },
    ],
    [
      "zero rows",
      (value: ReturnType<typeof wire>) => {
        value.rows = 0;
      },
    ],
    [
      "invalid input escape",
      (value: ReturnType<typeof wire>) => {
        value.input.escape = 4 as 0;
      },
    ],
    [
      "oversized command draft",
      (value: ReturnType<typeof wire>) => {
        value.input.text = "x".repeat(2001);
      },
    ],
    [
      "invalid UTF-8 byte",
      (value: ReturnType<typeof wire>) => {
        value.decoder.utf8 = [256];
      },
    ],
    [
      "too many partial bytes",
      (value: ReturnType<typeof wire>) => {
        value.decoder.utf8 = [1, 2, 3, 4];
      },
    ],
    [
      "oversized unfinished control",
      (value: ReturnType<typeof wire>) => {
        value.decoder.control = "x".repeat(65537);
      },
    ],
    [
      "missing buffer",
      (value: ReturnType<typeof wire>) => {
        Reflect.deleteProperty(value.state.buffers, "alt");
      },
    ],
    [
      "nonfinite cursor",
      (value: ReturnType<typeof wire>) => {
        value.state.buffers.alt.x = Infinity;
      },
    ],
    [
      "null keyboard state",
      (value: ReturnType<typeof wire>) => {
        Reflect.set(value.state, "kittyKeyboard", null);
      },
    ],
    [
      "missing keyboard stack",
      (value: ReturnType<typeof wire>) => {
        Reflect.deleteProperty(value.state.kittyKeyboard!, "altStack");
      },
    ],
    [
      "unknown state fields",
      (value: ReturnType<typeof wire>) => {
        Reflect.set(value.state, "unexpected", "not a known mode");
      },
    ],
    [
      "undefined on the wire",
      (value: ReturnType<typeof wire>) => {
        Reflect.set(value.state.charset, "charset", undefined);
      },
    ],
    [
      "sparse array on the wire",
      (value: ReturnType<typeof wire>) => {
        value.decoder.utf8 = new Array(2);
      },
    ],
  ])("refuses %s without attempting restoration", (_name, change) => {
    const value = wire();
    change(value);
    expect(() => decodeTerminalCheckpoint(value)).toThrow("terminal.checkpointBusy");
  });
  it("refuses getters/cycles/exotic objects rather than invoking a JSON conversion", () => {
    const value = wire();
    const get = () => {
      throw new Error("must not run");
    };
    Object.defineProperty(value, "data", { get, enumerable: true });
    expect(() => decodeTerminalCheckpoint(value)).toThrow("terminal.checkpointBusy");
    expect(() => decodeTerminalCheckpoint(new Date())).toThrow("terminal.checkpointBusy");
    const cycle = wire();
    Reflect.set(cycle, "cycle", cycle);
    expect(() => decodeTerminalCheckpoint(cycle)).toThrow("terminal.checkpointBusy");
  });
  it("refuses over-budget native moves without truncating, retaining the larger background budget", () => {
    const checkpoint = fixture();
    checkpoint.data = "中".repeat(400_000);
    expect(() => encodeTerminalCheckpoint(checkpoint)).toThrow("terminal.checkpointBusy");
    const background = encodeTerminalCheckpoint(checkpoint, "background");
    expect(decodeTerminalCheckpoint(background, "background")).toStrictEqual(checkpoint);
    expect(() => decodeTerminalCheckpoint(background)).toThrow("terminal.checkpointBusy");
    expect(checkpoint.data).toHaveLength(400_000);
  });
});
