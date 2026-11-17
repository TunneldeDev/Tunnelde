import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const root = "examples/plugins/syntax-basic";
const sdk = readFileSync(`${root}/sdk.mjs`);
const source = "const value = 42;\n".repeat(2000);

function runPlugin() {
  const child = spawn(process.execPath, [`${root}/index.mjs`], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "editor.readRange") {
      const { offset, limit } = message.params;
      const text = source.slice(offset, offset + limit);
      child.stdin!.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            schemaVersion: 1,
            tabId: message.params.tabId,
            documentId: message.params.documentId,
            version: message.params.version,
            offset,
            totalLength: source.length,
            text,
            nextOffset: offset + text.length < source.length ? offset + text.length : null,
          },
        })}\n`,
      );
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { child, request };
}

describe("syntax-basic installable example", () => {
  it("pins the packaged SDK and supports real stdio inline/window commands", async () => {
    expect(createHash("sha256").update(sdk).digest("hex")).toBe(
      "c8f22cd663e1978e5ad751e24f27ade321b74746896e915c66a1a1f478f9aaf9",
    );
    const { child, request } = runPlugin();
    try {
      expect(await request("initialize", { apiVersion: 1, pluginId: "syntax-basic" })).toEqual({
        ok: true,
      });
      const inline = (await request("command.run", {
        command: "highlight",
        input: {
          mode: "inline",
          source: 'const answer = 42;\nconsole.log("hello");',
          document: { tabId: "e2e", documentId: "doc", version: 1, path: "/a.js", name: "a.js" },
          extensions: ["js"],
          _locale: "en-US",
        },
      })) as { tokens: Array<{ type: string }> };
      expect(inline.tokens.some((token) => token.type === "keyword")).toBe(true);
      const windowed = (await request("command.run", {
        command: "highlight",
        input: {
          mode: "window",
          source: null,
          document: {
            tabId: "e2e",
            documentId: "doc",
            version: 1,
            path: "/large.js",
            name: "large.js",
          },
          extensions: ["js"],
          range: { offset: 0, length: 16_384 },
          _locale: "en-US",
        },
      })) as { tokens: Array<{ start: number; end: number; type: string }> };
      expect(windowed.tokens.length).toBeGreaterThan(100);
      expect(windowed.tokens[0]).toEqual({ start: 0, end: 5, type: "keyword" });
      expect(windowed.tokens.every((token) => token.end <= 16_384)).toBe(true);
      expect(await request("shutdown", {})).toBeNull();
    } finally {
      child.stdin!.end();
    }
  });
});
