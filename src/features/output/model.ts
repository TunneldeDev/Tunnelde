import type { OutputSnapshot } from "@/lib/api/ipc";
import { matchesSearch, parseSearchQuery, type SearchQuery } from "@/lib/search/query";

export interface OutputEntry {
  id: number;
  timestamp: string;
  level: string;
  domain: string;
  plugin: string | null;
  message: string;
  kind: "application" | "operations";
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
// Strip terminal escapes and control characters; logs are text, never HTML.
const plain = (value: string) =>
  value
    // Log text may contain terminal escape/control codes from subprocesses.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
const text = (value: unknown) =>
  plain(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

export function parseDiagnostic(line: string): Omit<OutputEntry, "id"> {
  try {
    const item = record(JSON.parse(line));
    const fields = record(item.fields);
    const plugin = fields.plugin_id ?? fields.plugin ?? item.plugin_id;
    const domain =
      typeof fields.domain === "string"
        ? fields.domain
        : typeof item.target === "string"
          ? item.target.replace(/^tunnelde_lib(?:::)?/, "").replaceAll("::", ".") || "application"
          : "application";
    const level = text(fields.level ?? item.level ?? "INFO").toUpperCase();
    const message = text(fields.message ?? item.message ?? line);
    const details = Object.entries(fields)
      .filter(([key]) => !["message", "level", "plugin", "plugin_id", "domain"].includes(key))
      .map(([key, value]) => `${key}=${text(value)}`)
      .join(" · ");
    return {
      timestamp: typeof item.timestamp === "string" ? item.timestamp : "",
      level: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].includes(level) ? level : "INFO",
      domain: plain(domain),
      plugin: typeof plugin === "string" ? plain(plugin) : null,
      message: details ? `${message} · ${details}` : message,
      kind: "application",
    };
  } catch {
    return {
      timestamp: "",
      level: "INFO",
      domain: "application",
      plugin: null,
      message: plain(line),
      kind: "application",
    };
  }
}

export function snapshotEntries(snapshot: OutputSnapshot, nextId: () => number): OutputEntry[] {
  const entries = snapshot.diagnostic
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ ...parseDiagnostic(line), id: nextId() }));
  for (const item of [...snapshot.operations].reverse()) {
    entries.push({
      id: nextId(),
      timestamp: new Date(item.timestamp).toISOString(),
      level: "INFO",
      domain: item.action.split(".")[0] ?? "operations",
      plugin: item.action.startsWith("plugin.") ? item.target : null,
      message: `${item.action}${item.target ? ` · ${item.target}` : ""}`,
      kind: "operations",
    });
  }
  return entries.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
}

export function matchesOutput(
  entry: OutputEntry,
  channel: string,
  query: string | SearchQuery,
  minimum: string,
): boolean {
  const levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
  if (levels.indexOf(entry.level) < levels.indexOf(minimum)) return false;
  if (channel === "application" && entry.kind !== "application") return false;
  if (channel === "operations" && entry.kind !== "operations") return false;
  if (channel.startsWith("domain:") && entry.domain !== channel.slice(7)) return false;
  if (channel.startsWith("plugin:") && entry.plugin !== channel.slice(7)) return false;
  return matchesSearch(
    typeof query === "string"
      ? parseSearchQuery(query, ["level", "domain", "plugin", "source"])
      : query,
    `${entry.message} ${entry.domain} ${entry.plugin ?? ""} ${entry.level}`,
    {
      level: entry.level,
      domain: entry.domain,
      plugin: entry.plugin,
      source: entry.kind,
    },
  );
}

export function formatOutputTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour12: false });
}

export function formatOutput(entry: OutputEntry): string {
  const time = formatOutputTime(entry.timestamp);
  return `${time} [${entry.level}] [${entry.plugin ?? entry.domain}] ${entry.message}`.trim();
}

/** Bound both row count and content, including a single unusually large log line. */
export function boundOutput(entries: OutputEntry[]): { entries: OutputEntry[]; omitted: boolean } {
  let size = 0;
  const recent: OutputEntry[] = [];
  let omitted = false;
  for (let i = entries.length - 1; i >= 0 && recent.length < 2000; i--) {
    const entry = entries[i]!;
    const message =
      entry.message.length > 16384 ? `${entry.message.slice(0, 16384)}…` : entry.message;
    size += message.length + entry.domain.length + (entry.plugin?.length ?? 0) + 128;
    if (size > 1024 * 1024) break;
    recent.push(message === entry.message ? entry : { ...entry, message });
    omitted ||= message !== entry.message;
  }
  return { entries: recent.reverse(), omitted: omitted || recent.length < entries.length };
}
