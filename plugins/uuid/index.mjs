import { randomUUID } from "node:crypto";

export function renderView(locale = "en") {
  const zh = locale.startsWith("zh");
  return {
    title: zh ? "UUID 生成器" : "UUID Generator",
    blocks: [
      {
        type: "text",
        text: zh
          ? "使用系统安全随机源生成 UUID v4。仅在点击复制时写入剪贴板。"
          : "Generate UUID v4 values using the system's cryptographic random source. Copy results explicitly when needed.",
      },
      {
        type: "form",
        id: "uuid",
        fields: [
          { id: "count", type: "text", label: zh ? "数量（1–100）" : "Count (1–100)", value: "1" },
        ],
        actions: [
          { id: "generate", command: "generate", label: zh ? "生成 UUID" : "Generate UUIDs" },
        ],
      },
    ],
  };
}
export function runCommand(command, input = {}) {
  if (command !== "generate") throw new Error("Unknown command");
  const raw = String(input.count ?? "1").trim();
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(count) || count < 1 || count > 100) {
    return {
      error: true,
      text: String(input._locale ?? "").startsWith("zh")
        ? "数量必须是 1–100 之间的整数。"
        : "Count must be an integer between 1 and 100.",
    };
  }
  return { text: Array.from({ length: count }, () => randomUUID()).join("\n") };
}

import process from "node:process";
import { realpathSync } from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

function start() {
  const write = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }
    const { id, method, params = {} } = message;
    if (id === undefined) return;
    try {
      let result;
      if (method === "initialize") result = { ok: true };
      else if (method === "view.render") {
        if (params.view !== "main") throw new Error("Unknown view");
        result = renderView(params.locale);
      } else if (method === "command.run") result = runCommand(params.command, params.input ?? {});
      else if (method === "shutdown") {
        write({ jsonrpc: "2.0", id, result: null });
        process.exit(0);
      } else {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } });
        return;
      }
      write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
}
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  start();
