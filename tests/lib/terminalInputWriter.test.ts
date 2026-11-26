import { expect, it, vi } from "vitest";
import { createTerminalInputWriter } from "@/features/terminal/terminalInputWriter";
import { decodeBase64 } from "@/lib/text/base64";

it("sends the first key immediately and preserves a burst while IPC is blocked", async () => {
  let finish!: () => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const failed = vi.fn();
  const writer = createTerminalInputWriter(send, failed);
  writer.push("a");
  expect(send).toHaveBeenCalledOnce();
  for (const key of "bcdef\r") writer.push(key);
  expect(send).toHaveBeenCalledOnce();
  finish();
  await writer.drain();
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    send.mock.calls.map(([data]) => new TextDecoder().decode(decodeBase64(data))).join(""),
  ).toBe("abcdef\r");
  expect(failed).not.toHaveBeenCalled();
});

it("splits large multilingual and bracketed pastes below native byte limits without data loss", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const writer = createTerminalInputWriter(send, vi.fn());
  const text = "\x1b[200~" + "中文👩‍💻\r\n".repeat(20_000) + "\x1b[201~";
  writer.push(text);
  await writer.drain();
  const chunks = send.mock.calls.map(([data]) => decodeBase64(data));
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 16 * 1024)).toBe(true);
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  expect(new TextDecoder().decode(bytes)).toBe(text);
});

it("reports failures once, stops queued input, and never retries a possibly committed write", async () => {
  const error = new Error("connection lost");
  const send = vi.fn().mockRejectedValue(error);
  const failed = vi.fn();
  const writer = createTerminalInputWriter(send, failed);
  writer.push("first");
  writer.push("second\r");
  await expect(writer.drain()).rejects.toBe(error);
  writer.push("third");
  expect(send).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledExactlyOnceWith(error);
});

it("retires queued keys on disposal without executing them through a replacement renderer", async () => {
  let finish!: () => void;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const writer = createTerminalInputWriter(send, vi.fn());
  writer.push("first");
  writer.push("stale input");
  writer.dispose();
  finish();
  await writer.drain();
  expect(send).toHaveBeenCalledOnce();
});
