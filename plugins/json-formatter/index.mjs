export function renderView(locale = "en") {
  const zh = locale.startsWith("zh");
  return {
    title: zh ? "JSON 格式化" : "JSON Formatter",
    blocks: [
      {
        type: "text",
        text: zh
          ? "格式化与压缩 JSON，保留原始数字精度与键顺序。数据仅在本地处理。"
          : "Format or minify JSON while preserving number precision and key order. All processing stays local.",
      },
      {
        type: "form",
        id: "json",
        fields: [
          {
            id: "source",
            type: "textarea",
            label: zh ? "JSON 输入" : "JSON input",
            placeholder: '{ "hello": "world" }',
          },
          {
            id: "indent",
            type: "select",
            label: zh ? "缩进" : "Indentation",
            value: "2",
            options: [
              { value: "2", label: zh ? "2 空格" : "2 spaces" },
              { value: "4", label: zh ? "4 空格" : "4 spaces" },
              { value: "tab", label: "Tab" },
            ],
          },
        ],
        actions: [
          { id: "pretty", command: "pretty", label: zh ? "格式化" : "Format" },
          { id: "minify", command: "minify", label: zh ? "压缩" : "Minify" },
        ],
      },
    ],
  };
}

export function runCommand(command, input = {}) {
  if (!["pretty", "minify"].includes(command)) throw new Error("Unknown command");
  const source = String(input.source ?? "");
  const zh = String(input._locale ?? "").startsWith("zh");
  try {
    JSON.parse(source);
  } catch (cause) {
    const message = cause.message;
    const match = /position (\d+)/i.exec(message);
    const lineMatch = /line (\d+) column (\d+)/i.exec(message);
    let position = match ? Number(match[1]) : source.length;
    if (!match && lineMatch) {
      const lines = source.split("\n");
      position =
        lines.slice(0, Number(lineMatch[1]) - 1).reduce((sum, line) => sum + line.length + 1, 0) +
        Number(lineMatch[2]) -
        1;
    }
    const before = source.slice(0, position);
    const line = before.split("\n").length;
    const column = position - before.lastIndexOf("\n");
    return {
      error: true,
      title: zh ? "JSON 无效" : "Invalid JSON",
      text:
        (zh
          ? `第 ${line} 行，第 ${column} 列（位置 ${position}）\n`
          : `Line ${line}, column ${column} (position ${position})\n`) + message,
      position,
      line,
      column,
    };
  }
  const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s"{}[\]:,]+|[{}[\]:,]/g) ?? [];
  if (command === "minify") return { text: tokens.join("") };
  const indent = input.indent === "tab" ? "\t" : input.indent === "4" ? "    " : "  ";
  let depth = 0;
  let output = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    if (token === "{" || token === "[") {
      output += token;
      depth++;
      if (next !== "}" && next !== "]") output += "\n" + indent.repeat(depth);
    } else if (token === "}" || token === "]") {
      depth--;
      if (previous !== "{" && previous !== "[") output += "\n" + indent.repeat(depth);
      output += token;
    } else if (token === ",") output += ",\n" + indent.repeat(depth);
    else if (token === ":") output += ": ";
    else output += token;
    if (depth > 256 || output.length > 1024 * 1024) {
      return {
        error: true,
        text: zh
          ? "JSON 嵌套过深或格式化结果过大。请缩小输入，或使用压缩操作。"
          : "JSON is too deeply nested or the formatted output is too large. Use a smaller input or minify instead.",
      };
    }
  }
  return { text: output };
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
