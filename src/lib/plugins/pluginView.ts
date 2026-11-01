import { normalizeChatBlock, type PluginChatBlock } from "./pluginChat";

export interface PluginField {
  id: string;
  type: "text" | "password" | "textarea" | "select";
  label: string;
  value: string;
  placeholder: string;
  options: { value: string; label: string }[];
}

export interface PluginFormBlock {
  type: "form";
  id: string;
  fields: PluginField[];
  actions: { id: string; label: string; command: string }[];
}

export type PluginBlock =
  | { type: "heading"; text: string }
  | { type: "text"; text: string }
  | { type: "kv"; items: { label: string; value: string }[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | PluginFormBlock
  | PluginChatBlock;

export const PLUGIN_INPUT_MAX_BYTES = 256 * 1024;
export const PLUGIN_RESULT_MAX_BYTES = 1024 * 1024;

function identifier(value: unknown): string {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    ![...Object.getOwnPropertyNames(Object.prototype), "prototype"].includes(value)
    ? value
    : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Results are plain text, never plugin-supplied HTML. Preserve formatting and whitespace. */
export function normalizeResult(value: unknown): { text: string; title: string; error: boolean } {
  const result = record(value);
  const body =
    typeof result.text === "string"
      ? result.text
      : typeof value === "string"
        ? value
        : (JSON.stringify(value, null, 2) ?? "");
  if (new TextEncoder().encode(body).length > PLUGIN_RESULT_MAX_BYTES)
    throw new Error("resultTooLarge");
  return { text: body, title: text(result.title), error: result.error === true };
}

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
  const formIds = new Set<string>();

  for (const raw of list(value).slice(0, MAX_BLOCKS)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;

    if (record.type === "chat") {
      const chat = normalizeChatBlock(record);
      if (chat && !blocks.some((block) => block.type === "chat")) blocks.push(chat);
      continue;
    }

    if (record.type === "form") {
      const id = identifier(record.id);
      if (!id || formIds.has(id)) continue;
      const fieldIds = new Set<string>();
      const fields: PluginField[] = [];
      for (const item of list(record.fields).slice(0, 20)) {
        const field =
          typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
        const fieldId = identifier(field.id);
        if (
          !fieldId ||
          fieldIds.has(fieldId) ||
          !text(field.label) ||
          !["text", "password", "textarea", "select"].includes(String(field.type))
        )
          continue;
        const optionValues = new Set<string>();
        const options = list(field.options)
          .slice(0, 100)
          .flatMap((item) => {
            const option =
              typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
            if (
              typeof option.value !== "string" ||
              option.value.length > 4000 ||
              !text(option.label) ||
              optionValues.has(option.value)
            )
              return [];
            optionValues.add(option.value);
            return [{ value: option.value, label: text(option.label) }];
          });
        if (field.type === "select" && options.length === 0) continue;
        const value =
          typeof field.value === "string" ? field.value.slice(0, PLUGIN_INPUT_MAX_BYTES) : "";
        fields.push({
          id: fieldId,
          type: field.type as PluginField["type"],
          label: text(field.label),
          value: field.type === "select" && !optionValues.has(value) ? options[0]!.value : value,
          placeholder: text(field.placeholder),
          options,
        });
        fieldIds.add(fieldId);
      }
      const actionIds = new Set<string>();
      const actions = list(record.actions)
        .slice(0, 12)
        .flatMap((item) => {
          const action =
            typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const actionId = identifier(action.id);
          const command = identifier(action.command);
          const label = text(action.label);
          if (!actionId || !command || !label || actionIds.has(actionId)) return [];
          actionIds.add(actionId);
          return [{ id: actionId, command, label }];
        });
      if (actions.length) {
        blocks.push({ type: "form", id, fields, actions });
        formIds.add(id);
      }
      continue;
    }

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
