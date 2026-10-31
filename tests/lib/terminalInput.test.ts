// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { consumeInput, type CommandCapture } from "@/lib/session/terminalInput";

const empty: CommandCapture = { text: "", escape: 0 };

describe("consumeInput", () => {
  it("submits a typed command on enter", () => {
    const first = consumeInput(empty, "ls -la");
    expect(first.commands).toEqual([]);
    const second = consumeInput(first.state, "\r");
    expect(second.commands).toEqual(["ls -la"]);
    expect(second.state.text).toBe("");
  });

  it("honours backspace", () => {
    const typed = consumeInput(empty, "lss");
    const fixed = consumeInput(typed.state, "\u007f");
    const submitted = consumeInput(fixed.state, "\r");
    expect(submitted.commands).toEqual(["ls"]);
  });

  it("ignores escape sequences", () => {
    const arrows = consumeInput(empty, "\u001b[A\u001b[B");
    expect(arrows.state.text).toBe("");
    const after = consumeInput(arrows.state, "pwd\r");
    expect(after.commands).toEqual(["pwd"]);
  });

  it("clears the line with ctrl+c", () => {
    const typed = consumeInput(empty, "dangerous");
    const cleared = consumeInput(typed.state, "\u0003");
    const submitted = consumeInput(cleared.state, "\r");
    expect(submitted.commands).toEqual([]);
  });

  it("splits pasted lines", () => {
    const pasted = consumeInput(empty, "echo a\rpwd\nuptime\r");
    expect(pasted.commands).toEqual(["echo a", "pwd", "uptime"]);
  });

  it("skips blank submissions", () => {
    const submitted = consumeInput(consumeInput(empty, "   ").state, "\r");
    expect(submitted.commands).toEqual([]);
  });

  it("preserves the leading-space history privacy marker", () => {
    const submitted = consumeInput(empty, " secret-command  \r");
    expect(submitted.commands).toEqual([" secret-command"]);
  });

  it("keeps long lines bounded", () => {
    const long = consumeInput(empty, "x".repeat(3000));
    expect(long.state.text.length).toBeLessThanOrEqual(2000);
  });
});
