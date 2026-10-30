// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

export type PluginBlock =
  | { type: "heading"; text: string }
  | { type: "text"; text: string }
  | { type: "kv"; items: { label: string; value: string }[] }
  | { type: "table"; columns: string[]; rows: string[][] };

const MAX_BLOCKS = 100;
const MAX_TEXT = 4000;
const MAX_ITEMS = 50;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;

function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT).trim() : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Turns the JSON a plugin returned into blocks the host can render. Unknown
 * entries are dropped instead of failing the whole view.
 */
export function normalizeBlocks(value: unknown): PluginBlock[] {
  const blocks: PluginBlock[] = [];

  for (const raw of list(value).slice(0, MAX_BLOCKS)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;

    if (record.type === "heading" || record.type === "text") {
      const body = text(record.text);
      if (body) {
        blocks.push({ type: record.type, text: body });
      }
      continue;
    }

    if (record.type === "kv") {
      const items = list(record.items)
        .slice(0, MAX_ITEMS)
        .map((item) => {
          const entry = (typeof item === "object" && item !== null ? item : {}) as Record<
            string,
            unknown
          >;
          return { label: text(entry.label), value: text(entry.value) };
        })
        .filter((item) => item.label || item.value);
      if (items.length > 0) {
        blocks.push({ type: "kv", items });
      }
      continue;
    }

    if (record.type === "table") {
      const columns = list(record.columns)
        .slice(0, MAX_COLUMNS)
        .map((column) => text(column));
      if (columns.length === 0) {
        continue;
      }
      const rows = list(record.rows)
        .slice(0, MAX_ROWS)
        .map((row) => {
          const cells = list(row).slice(0, columns.length);
          return columns.map((_, index) => text(cells[index]));
        });
      blocks.push({ type: "table", columns, rows });
    }
  }

  return blocks;
}

export function viewTitle(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  return text((value as Record<string, unknown>).title);
}
