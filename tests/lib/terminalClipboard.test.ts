import type { Terminal } from "@xterm/xterm";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTerminalClipboard } from "@/features/terminal/terminalClipboard";
import { encodeBase64 } from "@/lib/text/base64";

afterEach(() => vi.restoreAllMocks());

describe("application clipboard writes", () => {
  it("accepts OSC 52 during a TUI selection before mouseup without granting reads", () => {
    let handler!: (data: string) => boolean;
    const terminal = {
      hasSelection: () => false,
      modes: { mouseTrackingMode: "none" },
      parser: {
        registerOscHandler: (_: number, callback: typeof handler) => {
          handler = callback;
          return { dispose: vi.fn() };
        },
      },
    } as unknown as Terminal;
    const element = document.createElement("div");
    document.body.append(element);
    const write = vi.fn().mockResolvedValue(undefined);
    const binding = bindTerminalClipboard(terminal, element, () => true, write, vi.fn());
    handler(`c;${encodeBase64("not user initiated")}`);
    expect(write).not.toHaveBeenCalled();
    fireEvent.keyDown(element, { key: "c", ctrlKey: true });
    handler(`c;${encodeBase64("after interrupt")}`);
    expect(write).not.toHaveBeenCalled();
    fireEvent.mouseDown(element, { button: 0 });
    handler(`c;${encodeBase64("copied before release")}`);
    expect(write).toHaveBeenCalledWith("copied before release");
    handler("c;?");
    expect(write).toHaveBeenCalledOnce();
    binding.dispose();
    element.remove();
  });
  it("rejects disabled, expired, malformed, oversized and clipboard-read requests", async () => {
    let handler!: (data: string) => boolean;
    const release = vi.fn();
    const terminal = {
      parser: {
        registerOscHandler: (_id: number, callback: typeof handler) => {
          handler = callback;
          return { dispose: release };
        },
      },
    } as unknown as Terminal;
    const element = document.createElement("div");
    document.body.append(element);
    let enabled = false;
    const write = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const binding = bindTerminalClipboard(terminal, element, () => enabled, write, error);
    const select = () => {
      fireEvent.mouseDown(element, { button: 0 });
      fireEvent.mouseUp(element, { button: 0 });
    };
    select();
    handler(`c;${encodeBase64("disabled")}`);
    expect(write).not.toHaveBeenCalled();
    enabled = true;
    for (const data of [
      "c;?",
      "c;",
      "p;YWJj",
      "s;YWJj",
      "c;%%%",
      "c;/w==",
      `c;${"a".repeat(100_004)}`,
    ]) {
      expect(handler(data)).toBe(true);
    }
    expect(write).not.toHaveBeenCalled();
    now.mockReturnValue(10_101);
    handler("c;YWJj");
    expect(write).not.toHaveBeenCalled();
    select();
    write.mockRejectedValueOnce(new Error("clipboard unavailable"));
    handler("c;YWJj");
    await Promise.resolve();
    expect(error).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("abc");
    select();
    binding.dispose();
    handler("c;YWJj");
    expect(write).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    element.remove();
  });
});
