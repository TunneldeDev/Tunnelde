/** Host-owned semantic token vocabulary. Plugin values are never treated as CSS. */
export const SYNTAX_TOKEN_TYPES = [
  "keyword",
  "string",
  "number",
  "comment",
  "type",
  "function",
  "property",
  "operator",
  "punctuation",
  "variable",
  "constant",
  "invalid",
] as const;

export type SyntaxTokenType = (typeof SYNTAX_TOKEN_TYPES)[number];

export interface SyntaxToken {
  readonly start: number;
  readonly end: number;
  readonly type: SyntaxTokenType;
}

export interface SyntaxResult {
  readonly tokens: readonly SyntaxToken[];
}

export interface SyntaxProvider {
  id: string;
  command: string;
  title: string;
  extensions: string[];
}

export const SYNTAX_SOURCE_MAX_BYTES = 128 * 1024;
export const SYNTAX_REQUEST_MAX_BYTES = 256 * 1024;
export const SYNTAX_RESULT_MAX_BYTES = 128 * 1024;
export const SYNTAX_TOKEN_LIMIT = 16_384;

export function editorSyntaxMatches(path: string, extensions: readonly string[]): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return extensions.some((extension) => {
    const normalized = extension.toLowerCase();
    return name.endsWith(`.${normalized}`) || name === normalized;
  });
}

export function syntaxProviders(
  path: string,
  plugins: readonly {
    id: string;
    name: string;
    commands: readonly {
      id: string;
      title: string;
      editor?: { extensions: string[]; format?: boolean; syntax?: boolean };
    }[];
  }[],
): SyntaxProvider[] {
  return plugins.flatMap((plugin) =>
    plugin.commands
      .filter(
        (command) =>
          command.editor?.syntax === true &&
          command.editor.format !== true &&
          editorSyntaxMatches(path, command.editor.extensions),
      )
      .map((command) => ({
        id: plugin.id,
        command: command.id,
        title: `${plugin.name}: ${command.title}`,
        extensions: [...command.editor!.extensions],
      })),
  );
}

const bytes = (value: string) => new TextEncoder().encode(value).length;

function scalarBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** Validate the complete response before it can replace any visible tokens. */
export function parseSyntaxResult(value: unknown, content: string): SyntaxToken[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "tokens")) throw new Error("invalid");
  if (!Array.isArray(record.tokens) || record.tokens.length > SYNTAX_TOKEN_LIMIT)
    throw new Error("invalid");
  let previousEnd = 0;
  let serializedBytes = 0;
  if (bytes(JSON.stringify(record)) > SYNTAX_RESULT_MAX_BYTES) throw new Error("invalid");
  return record.tokens.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
    const token = raw as Record<string, unknown>;
    if (Object.keys(token).some((key) => key !== "start" && key !== "end" && key !== "type"))
      throw new Error("invalid");
    const { start, end, type } = token;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof type !== "string" ||
      !(SYNTAX_TOKEN_TYPES as readonly string[]).includes(type) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < previousEnd ||
      end <= start ||
      !scalarBoundary(content, start) ||
      !scalarBoundary(content, end)
    )
      throw new Error("invalid");
    previousEnd = end;
    const normalized: SyntaxToken = { start, end, type: type as SyntaxTokenType };
    serializedBytes += bytes(JSON.stringify(normalized));
    if (serializedBytes > SYNTAX_RESULT_MAX_BYTES) throw new Error("invalid");
    return normalized;
  });
}

/** Split text into escaped React-ready pieces without trusting plugin markup. */
export function syntaxSegments(
  content: string,
  tokens: readonly SyntaxToken[],
): Array<{ text: string; type: SyntaxTokenType | null }> {
  const segments: Array<{ text: string; type: SyntaxTokenType | null }> = [];
  let offset = 0;
  for (const token of tokens) {
    if (token.start > offset)
      segments.push({ text: content.slice(offset, token.start), type: null });
    segments.push({ text: content.slice(token.start, token.end), type: token.type });
    offset = token.end;
  }
  if (offset < content.length) segments.push({ text: content.slice(offset), type: null });
  return segments;
}
