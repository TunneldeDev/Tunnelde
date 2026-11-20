import type { TerminalCheckpoint } from "./terminalCheckpoint";
import type { TerminalState } from "./terminalState";

// Private, ephemeral transport only. Contains screen/command drafts; never put
// this in preferences, public events, plugin discovery, logs or the plugin bus.
type Charset = Record<string, string> | null;
type BufferWire = Omit<TerminalState["buffers"]["normal"], "tabs" | "savedCharset"> & {
  tabs: Record<string, boolean | null>;
  savedCharset: Charset;
};
interface StateWire extends Omit<TerminalState, "buffers" | "privateModes" | "charset"> {
  buffers: { normal: BufferWire; alt: BufferWire };
  privateModes: Record<string, boolean | string | null>;
  charset: { charset: Charset; glevel: number; _charsets: Charset[] };
}
export interface TerminalCheckpointWire extends Omit<TerminalCheckpoint, "state"> {
  version: 1;
  state: StateWire;
}
type Transport = "panel" | "background";
const byteLimit = (transport: Transport) => (transport === "background" ? 64 : 1) * 1024 * 1024;
const invalid = () => new Error("terminal.checkpointBusy");
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const boolean = (value: unknown): value is boolean => typeof value === "boolean";
const string = (value: unknown): value is string => typeof value === "string";
function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function shape(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function record(value: unknown, valid: (value: unknown) => boolean): boolean {
  return object(value) && Object.values(value).every(valid);
}
const charset = (value: unknown) => value === null || record(value, string);
function buffer(value: unknown): boolean {
  if (
    !shape(value, [
      "x",
      "y",
      "ybase",
      "scrollTop",
      "scrollBottom",
      "tabs",
      "savedX",
      "savedY",
      "savedCurAttrData",
      "savedCharset",
    ])
  )
    return false;
  return (
    ["x", "y", "ybase", "scrollTop", "scrollBottom", "savedX", "savedY"].every((key) =>
      integer(value[key]),
    ) &&
    record(value.tabs, (entry) => entry === null || boolean(entry)) &&
    charset(value.savedCharset) &&
    shape(value.savedCurAttrData, ["fg", "bg"]) &&
    integer(value.savedCurAttrData.fg) &&
    integer(value.savedCurAttrData.bg)
  );
}
function state(value: unknown): boolean {
  if (
    !shape(
      value,
      ["buffers", "cursorHidden", "cursorInitialized", "privateModes", "mouseEncoding", "charset"],
      ["kittyKeyboard"],
    )
  )
    return false;
  if (
    !shape(value.buffers, ["normal", "alt"]) ||
    !buffer(value.buffers.normal) ||
    !buffer(value.buffers.alt) ||
    !boolean(value.cursorHidden) ||
    !boolean(value.cursorInitialized) ||
    !string(value.mouseEncoding) ||
    !record(value.privateModes, (entry) => entry === null || boolean(entry) || string(entry)) ||
    !shape(value.charset, ["charset", "glevel", "_charsets"]) ||
    !charset(value.charset.charset) ||
    !integer(value.charset.glevel) ||
    !Array.isArray(value.charset._charsets) ||
    !value.charset._charsets.every(charset)
  )
    return false;
  if (!Object.hasOwn(value, "kittyKeyboard")) return true;
  const kitty = value.kittyKeyboard;
  return (
    shape(kitty, ["flags", "mainFlags", "altFlags", "mainStack", "altStack"]) &&
    [kitty.flags, kitty.mainFlags, kitty.altFlags].every(integer) &&
    [kitty.mainStack, kitty.altStack].every((stack) => Array.isArray(stack) && stack.every(integer))
  );
}

/** Reject silently lossy JSON (undefined, holes, getters, nonfinite numbers,
 * cycles and unknown object prototypes) before any serialization/teardown. */
function checkedJson(value: unknown, transport: Transport): unknown {
  const maxBytes = byteLimit(transport);
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  function visit(value: unknown, depth: number): void {
    if (++nodes > 10_000 || depth > 32) throw invalid();
    if (string(value)) {
      bytes += encoder.encode(value).length;
      if (bytes > maxBytes) throw invalid();
      return;
    }
    if (value === null || boolean(value) || (typeof value === "number" && Number.isFinite(value)))
      return;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw invalid();
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !object(value)) throw invalid();
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || descriptor.get || descriptor.set) throw invalid();
      visit(key, depth + 1);
      visit(descriptor.value, depth + 1);
    }
    if (array && Object.keys(value).length !== value.length) throw invalid();
    ancestors.delete(value);
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (encoder.encode(text).length > maxBytes) throw invalid();
  return JSON.parse(text) as unknown;
}
function validCheckpoint(value: unknown): value is TerminalCheckpointWire {
  return (
    shape(value, [
      "version",
      "sequence",
      "cols",
      "rows",
      "viewportY",
      "data",
      "decoder",
      "state",
      "input",
    ]) &&
    value.version === 1 &&
    integer(value.sequence) &&
    integer(value.cols) &&
    value.cols > 0 &&
    integer(value.rows) &&
    value.rows > 0 &&
    integer(value.viewportY) &&
    string(value.data) &&
    shape(value.decoder, ["utf8", "control"]) &&
    string(value.decoder.control) &&
    value.decoder.control.length <= 65536 &&
    Array.isArray(value.decoder.utf8) &&
    value.decoder.utf8.length <= 3 &&
    value.decoder.utf8.every((byte) => integer(byte) && byte <= 255) &&
    shape(value.input, ["text", "escape"]) &&
    string(value.input.text) &&
    value.input.text.length <= 2000 &&
    integer(value.input.escape) &&
    value.input.escape <= 3 &&
    state(value.state)
  );
}
function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
function bufferWire(value: TerminalState["buffers"]["normal"]): BufferWire {
  return {
    ...value,
    tabs: Object.fromEntries(
      Object.entries(value.tabs).map(([key, value]) => [key, nullable(value)]),
    ),
    savedCharset: nullable(value.savedCharset),
  };
}

/** JSON.stringify alone drops undefined charsets/modes and changes array slots
 * into null. Use explicit nullable fields, then restore the pinned xterm shape. */
export function encodeTerminalCheckpoint(
  checkpoint: TerminalCheckpoint,
  transport: Transport = "panel",
): TerminalCheckpointWire {
  const { state, ...base } = checkpoint;
  const { kittyKeyboard, ...stateBase } = state;
  const wire = checkedJson(
    {
      ...base,
      version: 1,
      state: {
        ...stateBase,
        ...(kittyKeyboard === undefined ? {} : { kittyKeyboard }),
        buffers: { normal: bufferWire(state.buffers.normal), alt: bufferWire(state.buffers.alt) },
        privateModes: Object.fromEntries(
          Object.entries(state.privateModes).map(([key, value]) => [key, nullable(value)]),
        ),
        charset: {
          ...state.charset,
          charset: nullable(state.charset.charset),
          _charsets: Array.from(state.charset._charsets, nullable),
        },
      },
    },
    transport,
  );
  if (!validCheckpoint(wire)) throw invalid();
  return wire;
}
export function decodeTerminalCheckpoint(
  value: unknown,
  transport: Transport = "panel",
): TerminalCheckpoint {
  const wire = checkedJson(value, transport);
  if (!validCheckpoint(wire)) throw invalid();
  const { version: _version, state, ...checkpoint } = wire;
  const restoreBuffer = (buffer: BufferWire) => ({
    ...buffer,
    tabs: Object.fromEntries(
      Object.entries(buffer.tabs).map(([key, value]) => [key, value ?? undefined]),
    ),
    savedCharset: buffer.savedCharset ?? undefined,
  });
  return {
    ...checkpoint,
    state: {
      ...state,
      buffers: {
        normal: restoreBuffer(state.buffers.normal),
        alt: restoreBuffer(state.buffers.alt),
      },
      privateModes: Object.fromEntries(
        Object.entries(state.privateModes).map(([key, value]) => [key, value ?? undefined]),
      ),
      charset: {
        ...state.charset,
        charset: state.charset.charset ?? undefined,
        _charsets: state.charset._charsets.map((entry) => entry ?? undefined),
      },
    },
  };
}
