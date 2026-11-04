import type { Terminal } from "@xterm/xterm";

type Charset = Record<string, string> | undefined;
interface BufferState {
  x: number;
  y: number;
  ybase: number;
  scrollTop: number;
  scrollBottom: number;
  tabs: Record<string, boolean | undefined>;
  savedX: number;
  savedY: number;
  savedCurAttrData: { fg: number; bg: number };
  savedCharset: Charset;
}

interface Core {
  buffers: { normal: BufferState; alt: BufferState };
  coreService: {
    isCursorHidden: boolean;
    isCursorInitialized: boolean;
    decPrivateModes: Record<string, boolean | string | undefined>;
  };
  coreMouseService: { activeEncoding: string };
  _charsetService: {
    charset: Charset;
    glevel: number;
    _charsets: Charset[];
  };
}

export interface TerminalState {
  buffers: { normal: BufferState; alt: BufferState };
  cursorHidden: boolean;
  cursorInitialized: boolean;
  privateModes: Core["coreService"]["decPrivateModes"];
  mouseEncoding: string;
  charset: Core["_charsetService"];
}

// SerializeAddon 0.14 restores cells, colors and basic modes, but omits scrolling
// margins, saved cursors, tab stops, character sets and SGR mouse encoding.
// This narrow adapter is tied to our pinned xterm 6.0.0. Roundtrip tests run its
// actual distributed parser. If its shape changes, refuse teardown safely.
function coreOf(terminal: Terminal): Core {
  const core = (terminal as unknown as { _core: Core })._core;
  if (
    !core?.buffers?.normal?.savedCurAttrData ||
    !core.buffers.alt?.tabs ||
    !core.coreService?.decPrivateModes ||
    !core.coreMouseService ||
    !core._charsetService
  ) {
    throw new Error("terminal.checkpointBusy");
  }
  return core;
}

function snapshotBuffer(buffer: BufferState): BufferState {
  const { x, y, ybase, scrollTop, scrollBottom, tabs, savedX, savedY, savedCharset } = buffer;
  return {
    x,
    y,
    ybase,
    scrollTop,
    scrollBottom,
    tabs: { ...tabs },
    savedX,
    savedY,
    savedCurAttrData: { fg: buffer.savedCurAttrData.fg, bg: buffer.savedCurAttrData.bg },
    savedCharset: savedCharset ? { ...savedCharset } : undefined,
  };
}

export function captureTerminalState(terminal: Terminal): TerminalState {
  const core = coreOf(terminal);
  return structuredClone({
    buffers: { normal: snapshotBuffer(core.buffers.normal), alt: snapshotBuffer(core.buffers.alt) },
    cursorHidden: core.coreService.isCursorHidden,
    cursorInitialized: core.coreService.isCursorInitialized,
    privateModes: { ...core.coreService.decPrivateModes, synchronizedOutput: false },
    mouseEncoding: core.coreMouseService.activeEncoding,
    charset: {
      charset: core._charsetService.charset,
      glevel: core._charsetService.glevel,
      _charsets: core._charsetService._charsets,
    },
  });
}

export function restoreTerminalState(terminal: Terminal, state: TerminalState) {
  const core = coreOf(terminal);
  for (const name of ["normal", "alt"] as const) {
    const buffer = core.buffers[name];
    const saved = state.buffers[name];
    const baseDelta = buffer.ybase - saved.ybase;
    Object.assign(buffer, {
      x: saved.x,
      y: saved.y,
      scrollTop: saved.scrollTop,
      scrollBottom: saved.scrollBottom,
      tabs: { ...saved.tabs },
      savedX: saved.savedX,
      savedY: Math.max(0, saved.savedY + baseDelta),
      savedCharset: saved.savedCharset,
    });
    Object.assign(buffer.savedCurAttrData, saved.savedCurAttrData);
  }
  core.coreService.isCursorHidden = state.cursorHidden;
  core.coreService.isCursorInitialized = state.cursorInitialized;
  Object.assign(core.coreService.decPrivateModes, state.privateModes);
  core.coreMouseService.activeEncoding = state.mouseEncoding;
  Object.assign(core._charsetService, state.charset);
}
