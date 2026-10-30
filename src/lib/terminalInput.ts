// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

export interface CommandCapture {
  text: string;
  /** 0 = none, 1 = after ESC, 2 = inside CSI ([), 3 = inside SS3 (O). */
  escape: 0 | 1 | 2 | 3;
}

export interface CaptureResult {
  state: CommandCapture;
  commands: string[];
}

const MAX_LINE = 2000;

/**
 * Turns raw xterm input into submitted command lines. Escape sequences
 * (arrows, function keys, bracketed paste markers) are skipped, backspace
 * edits, Ctrl+C clears and newlines submit.
 */
export function consumeInput(state: CommandCapture, data: string): CaptureResult {
  let text = state.text;
  let escape = state.escape;
  const commands: string[] = [];

  for (const character of data) {
    if (escape !== 0) {
      const code = character.charCodeAt(0);
      if (escape === 1) {
        if (character === "[") {
          escape = 2;
        } else if (character === "O") {
          escape = 3;
        } else if (code >= 0x40 && code <= 0x7e) {
          escape = 0;
        }
      } else if (code >= 0x40 && code <= 0x7e) {
        escape = 0;
      }
      continue;
    }

    if (character === "\u001b") {
      escape = 1;
      continue;
    }

    if (character === "\r" || character === "\n") {
      const command = text.trim();
      if (command.length > 0) {
        commands.push(command);
      }
      text = "";
      continue;
    }

    if (character === "\u007f" || character === "\b") {
      text = text.slice(0, -1);
      continue;
    }

    if (character === "\u0003") {
      text = "";
      continue;
    }

    if (character >= " ") {
      text += character;
      if (text.length > MAX_LINE) {
        text = text.slice(-MAX_LINE);
      }
    }
  }

  return { state: { text, escape }, commands };
}
