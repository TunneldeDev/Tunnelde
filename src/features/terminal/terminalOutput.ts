export interface TerminalDecoderState {
  utf8: number[];
  control: string;
}

const MAX_CONTROL_BYTES = 64 * 1024;
type ControlMode = "ground" | "escape" | "csi" | "string" | "stringEscape";

/** Track only the unfinished control sequence; completed output belongs to xterm. */
function controlTail() {
  let mode: ControlMode = "ground";
  let pending = "";
  let oversized = false;
  let osc = false;
  const clear = () => {
    mode = "ground";
    pending = "";
    oversized = false;
  };
  return {
    consume(text: string) {
      for (const character of text) {
        const code = character.codePointAt(0)!;
        if (code === 0x18 || code === 0x1a || code === 0x9c) {
          clear();
          continue;
        }
        if (mode === "string" || mode === "stringEscape") {
          if ((osc && code === 7) || (mode === "stringEscape" && character === "\\")) {
            clear();
            continue;
          }
          mode = code === 0x1b ? "stringEscape" : "string";
        } else if (code === 0x1b) {
          mode = "escape";
          pending = "";
          oversized = false;
        } else if ([0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f].includes(code)) {
          mode = code === 0x9b ? "csi" : "string";
          osc = code === 0x9d;
          pending = "";
          oversized = false;
        } else if (mode === "escape" && code >= 0x30 && code <= 0x7e) {
          if (character === "[") mode = "csi";
          else if (["]", "P", "X", "^", "_"].includes(character)) {
            mode = "string";
            osc = character === "]";
          } else {
            clear();
            continue;
          }
        } else if (mode === "csi" && code >= 0x40 && code <= 0x7e) {
          clear();
          continue;
        }
        if (mode !== "ground" && !oversized) {
          pending += character;
          if (pending.length > MAX_CONTROL_BYTES) {
            pending = "";
            oversized = true;
          }
        }
      }
    },
    snapshot() {
      if (oversized) throw new Error("terminal.checkpointBusy");
      return pending;
    },
  };
}

function incompleteUtf8(bytes: Uint8Array): number[] {
  let start = bytes.length - 1;
  while (start >= Math.max(0, bytes.length - 3) && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return [];
  const lead = bytes[start]!;
  const expected =
    lead >= 0xf0 && lead <= 0xf4
      ? 4
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xc2 && lead <= 0xdf
          ? 2
          : 1;
  const second = bytes[start + 1];
  if (
    second !== undefined &&
    ((lead === 0xe0 && second < 0xa0) ||
      (lead === 0xed && second >= 0xa0) ||
      (lead === 0xf0 && second < 0x90) ||
      (lead === 0xf4 && second >= 0x90))
  )
    return [];
  return expected > bytes.length - start ? Array.from(bytes.slice(start)) : [];
}

/** Streaming UTF-8 decoding with a bounded, replayable parser tail for window recreation. */
export function createTerminalOutputDecoder(initial?: TerminalDecoderState) {
  const decoder = new TextDecoder();
  const control = controlTail();
  let utf8 = initial?.utf8 ?? [];
  if (utf8.length) decoder.decode(new Uint8Array(utf8), { stream: true });
  if (initial?.control) control.consume(initial.control);
  return Object.assign(
    (chunk: Uint8Array) => {
      // When a new packet is large, its last bytes alone determine any tail.
      if (chunk.length >= 4) {
        utf8 = incompleteUtf8(chunk.subarray(chunk.length - 4));
      } else {
        const tail = new Uint8Array(utf8.length + chunk.length);
        tail.set(utf8);
        tail.set(chunk, utf8.length);
        utf8 = incompleteUtf8(tail);
      }
      const text = decoder.decode(chunk, { stream: true });
      control.consume(text);
      return text;
    },
    { checkpoint: (): TerminalDecoderState => ({ utf8: [...utf8], control: control.snapshot() }) },
  );
}
