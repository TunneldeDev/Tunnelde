import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import type * as XtermModule from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalBridge } from "@/lib/extensions/terminal";

const require = createRequire(import.meta.url);
const module = { exports: {} as typeof XtermModule };
runInNewContext(readFileSync(require.resolve("@xterm/xterm"), "utf8"), {
  module,
  exports: module.exports,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  performance,
  process,
  structuredClone,
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
function fixture(cols = 80, rows = 24) {
  const terminal = new module.exports.Terminal({
    cols,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const report = vi.fn();
  const bridge = createTerminalBridge("session", report);
  cleanup.push(
    () => terminal.dispose(),
    () => bridge.dispose(),
  );
  const detach = bridge.attach(terminal);
  bridge.update({ hostId: "host", title: "Host", status: "ready" });
  const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));
  return { terminal, bridge, api: bridge.api, detach, write, report };
}

it("projects independent immutable metadata and parsed text, rejecting stale pages", async () => {
  const { api, bridge, write } = fixture();
  const before = api.readState();
  expect(Object.isFrozen(before)).toBe(true);
  await write("\x1b[31mhello\x1b[0m\r\nworld");
  const state = api.readState();
  expect(state.revision).toBeGreaterThan(before.revision);
  expect(() => api.readLines({ revision: before.revision })).toThrow("changed");
  const page = api.readLines({ revision: state.revision, offset: 0 });
  expect(page.lines.slice(0, 2).map((line) => line.text)).toEqual(["hello", "world"]);
  expect(Object.isFrozen(page.lines[0])).toBe(true);
  bridge.update({ title: "Renamed" });
  expect(before.title).toBe("Host");
  expect(api.readState().title).toBe("Renamed");
  for (const offset of [-1, 0.5, NaN, Infinity, state.totalLines + 1])
    expect(() => api.readLines({ offset })).toThrow("invalid");
  expect(() => api.readLines(null!)).toThrow("invalid");
});
it("bounds pages and long rows without dropping the next row at the page boundary", async () => {
  const { api, write } = fixture(5000, 24);
  await write(Array.from({ length: 150 }, (_, i) => `${i}:` + "x".repeat(4500)).join("\r\n"));
  const page = api.readLines({ offset: 0 });
  expect(page.lines.length).toBe(16);
  expect(page.lines.every((line) => line.text.length === 4096 && line.truncated)).toBe(true);
  expect(page.lines.reduce((n, line) => n + line.text.length, 0)).toBe(65536);
  const next = api.readLines({ revision: page.revision, offset: page.nextOffset! });
  expect(next.lines[0]!.row).toBe(page.lines.at(-1)!.row + 1);
  expect(next.lines[0]!.text).toMatch(/^16:/);
  const short = fixture();
  await short.write("x\r\n".repeat(180));
  expect(short.api.readLines({ offset: 0 }).lines).toHaveLength(128);
});
it("coalesces parsed output notifications, supports duplicate callbacks and releases aborted subscriptions", async () => {
  const { api, write } = fixture();
  const receive = vi.fn();
  const controller = new AbortController();
  const stop = api.subscribe(receive);
  api.subscribe(receive, { signal: controller.signal });
  await write("one");
  await write("two");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive.mock.calls[0]![0].changes).toContain("output");
  expect(Object.isFrozen(receive.mock.calls[0]![0])).toBe(true);
  controller.abort();
  stop();
  await write("three");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(receive).toHaveBeenCalledTimes(2);
});
it("enforces subscription quotas and removes a throwing receiver", async () => {
  const { api, write, report } = fixture();
  const stops = Array.from({ length: 16 }, () => api.subscribe(() => {}));
  expect(() => api.subscribe(() => {})).toThrow("subscriptionLimit");
  stops.forEach((stop) => stop());
  const fail = vi.fn(() => {
    throw new Error("bad receiver");
  });
  api.subscribe(fail);
  await write("one");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await write("two");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(fail).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  expect(() => api.subscribe(null!)).toThrow("invalid");
  expect(() => api.subscribe(() => {}, null!)).toThrow("invalid");
  expect(() => api.subscribe(() => {}, { signal: {} as AbortSignal })).toThrow("invalid");
});
it("uses native input and bracketed paste and stops input when suspended, closed or disposed", async () => {
  const { terminal, api, bridge, detach, write } = fixture();
  // No renderer is opened in this parser test; native paste clears its textarea.
  (terminal as unknown as { _core: { textarea: { value: string } } })._core.textarea = {
    value: "",
  };
  const data = vi.fn();
  terminal.onData(data);
  api.send("pwd\r");
  expect(data).toHaveBeenLastCalledWith("pwd\r");
  await write("\x1b[?2004h");
  api.paste("a\nb");
  expect(data).toHaveBeenLastCalledWith("\x1b[200~a\rb\x1b[201~");
  for (const text of ["", "x".repeat(65537), null])
    expect(() => api.send(text!)).toThrow("invalid");
  bridge.update({ status: "suspended" });
  expect(() => api.send("x")).toThrow("unavailable");
  expect(() => api.readLines()).toThrow("unavailable");
  bridge.update({ status: "closed" });
  expect(() => api.paste("x")).toThrow("unavailable");
  expect(api.readLines().lines.length).toBeGreaterThan(0);
  detach();
  expect(() => api.readLines()).toThrow("unavailable");
  bridge.dispose();
  expect(() => api.readState()).toThrow("unavailable");
});
