export function renderView(locale = "en") {
  const zh = locale.startsWith("zh");
  return {
    title: zh ? "时间戳转换" : "Timestamp Converter",
    blocks: [
      {
        type: "text",
        text: zh
          ? "在 Unix 时间戳与日期时间之间转换。无偏移量的日期按所选时区解释；带 Z 或偏移量的日期使用其自带时区。"
          : "Convert Unix timestamps and dates. Dates without an offset use the selected time zone; explicit Z or offsets are respected.",
      },
      {
        type: "form",
        id: "timestamp",
        fields: [
          {
            id: "timestamp",
            type: "text",
            label: zh ? "Unix 时间戳" : "Unix timestamp",
            value: "0",
          },
          {
            id: "unit",
            type: "select",
            label: zh ? "时间戳单位" : "Timestamp unit",
            value: "seconds",
            options: [
              { value: "seconds", label: zh ? "秒" : "Seconds" },
              { value: "milliseconds", label: zh ? "毫秒" : "Milliseconds" },
            ],
          },
          {
            id: "zone",
            type: "select",
            label: zh ? "时区" : "Time zone",
            value: "local",
            options: [
              { value: "local", label: zh ? "本地时区" : "Local" },
              { value: "utc", label: "UTC" },
            ],
          },
          {
            id: "datetime",
            type: "text",
            label: zh ? "日期时间" : "Date and time",
            placeholder: "2026-11-01T12:30:00",
          },
        ],
        actions: [
          { id: "decode", command: "decode", label: zh ? "时间戳 → 日期" : "Timestamp → date" },
          { id: "encode", command: "encode", label: zh ? "日期 → 时间戳" : "Date → timestamp" },
          { id: "now", command: "now", label: zh ? "当前时间" : "Current time" },
        ],
      },
    ],
  };
}

function parseDate(raw, zone) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      raw.trim(),
    );
  if (!match) throw new Error("date");
  const [, y, m, d, h, min, s = "0", fraction = "", offset] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, h, min, s].map(Number);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    throw new Error("date");
  const ms = Number(fraction.padEnd(3, "0"));
  const date = new Date(0);
  if (offset || zone === "utc") {
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, ms);
    if (offset && offset !== "Z") {
      const oh = Number(offset.slice(1, 3)),
        om = Number(offset.slice(4, 6));
      if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) throw new Error("date");
      date.setTime(date.getTime() - (offset[0] === "+" ? 1 : -1) * (oh * 60 + om) * 60000);
    }
  } else {
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, ms);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute
    )
      throw new Error("date");
  }
  return date;
}
const pad = (n, width = 2) => String(n).padStart(width, "0");
function localISO(date) {
  const offset = -date.getTimezoneOffset(),
    sign = offset < 0 ? "-" : "+",
    absolute = Math.abs(offset);
  const year = date.getFullYear();
  const yearText =
    year < 0 || year > 9999 ? (year < 0 ? "-" : "+") + pad(Math.abs(year), 6) : pad(year, 4);
  return `${yearText}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function timestampMilliseconds(raw, unit) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error("timestamp");
  const negative = raw.startsWith("-");
  const [integer = "0", fraction = ""] = raw.replace(/^[+-]/, "").split(".");
  const significant = fraction.replace(/0+$/, "");
  const precision = unit === "milliseconds" ? 0 : 3;
  if (significant.length > precision || integer.replace(/^0+/, "").length > 16)
    throw new Error("timestamp");
  const milliseconds =
    BigInt(integer || "0") * (precision === 0 ? 1n : 1000n) +
    BigInt(significant.padEnd(precision, "0") || "0");
  if (milliseconds > 8640000000000000n) throw new Error("timestamp");
  return Number(negative ? -milliseconds : milliseconds);
}

function secondsText(milliseconds) {
  const absolute = BigInt(Math.abs(milliseconds));
  const fraction = String(absolute % 1000n)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return (
    (milliseconds < 0 ? "-" : "") + String(absolute / 1000n) + (fraction ? "." + fraction : "")
  );
}
export function runCommand(command, input = {}) {
  if (!["decode", "encode", "now"].includes(command)) throw new Error("Unknown command");
  const zh = String(input._locale ?? "").startsWith("zh");
  try {
    let date;
    if (command === "now") date = new Date();
    else if (command === "encode") date = parseDate(String(input.datetime ?? ""), input.zone);
    else {
      const raw = String(input.timestamp ?? "").trim();
      date = new Date(timestampMilliseconds(raw, input.unit));
    }
    if (!Number.isFinite(date.getTime())) throw new Error("date");
    const milliseconds = date.getTime();
    return {
      text: [
        (zh ? "Unix 秒: " : "Unix seconds: ") + secondsText(milliseconds),
        (zh ? "Unix 毫秒: " : "Unix milliseconds: ") + milliseconds,
        "UTC: " + date.toISOString(),
        (zh ? "本地: " : "Local: ") + localISO(date),
        (zh ? "所选时区: " : "Selected zone: ") +
          (input.zone === "utc" ? date.toISOString() : localISO(date)),
      ].join("\n"),
    };
  } catch {
    return {
      error: true,
      text: zh
        ? "无效的时间戳或日期。请输入有效的日期时间（YYYY-MM-DDTHH:mm:ss），秒或毫秒时间戳。夏令时跳过的本地时间不可用。"
        : "Invalid timestamp or date. Use a valid date (YYYY-MM-DDTHH:mm:ss), or a timestamp in seconds or milliseconds. Local times skipped by daylight saving are invalid.",
    };
  }
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
