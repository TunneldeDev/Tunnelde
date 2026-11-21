import type { TerminalCheckpoint } from "@/features/terminal/terminalCheckpoint";

export function terminalCheckpointFixture(): TerminalCheckpoint {
  const buffer = () => ({
    x: 2,
    y: 1,
    ybase: 0,
    scrollTop: 0,
    scrollBottom: 11,
    tabs: { 8: true, 16: undefined },
    savedX: 0,
    savedY: 0,
    savedCurAttrData: { fg: 0, bg: 0 },
    savedCharset: undefined,
  });
  return {
    sequence: 7,
    cols: 80,
    rows: 12,
    viewportY: 0,
    data: "screen",
    decoder: { utf8: [0xe4, 0xb8], control: "\x1b[3" },
    input: { text: "partial", escape: 2 },
    state: {
      buffers: { normal: buffer(), alt: buffer() },
      cursorHidden: false,
      cursorInitialized: true,
      privateModes: { wraparound: true, optional: undefined },
      mouseEncoding: "SGR",
      charset: { charset: undefined, glevel: 0, _charsets: [undefined, { q: "─" }] },
      kittyKeyboard: { flags: 7, mainFlags: 1, altFlags: 7, mainStack: [0, 1], altStack: [0] },
    },
  };
}
