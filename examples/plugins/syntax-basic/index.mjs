#!/usr/bin/env node
/**
 * Lightweight tokenizer, not a compiler-grade parser.
 * It highlights comments, strings, numbers and a conservative keyword set.
 * Install the folder, start the plugin and grant editor.read. Tunnelde only
 * invokes already-running authorized providers.
 */
const KEYWORDS = new Set(
  (
    "as async await break case catch class const continue default delete do else enum export extends " +
    "false finally for from function if implements import in instanceof interface let new null of " +
    "package private protected public return static super switch this throw true try type typeof var " +
    "void while with yield def elif except lambda pass raise and or not is None True False self " +
    "fn impl match mut pub struct trait use mod crate pub use go chan defer func interface map range " +
    "select package import public protected private static final new void int long double float boolean"
  ).split(/\s+/),
);
const LANGUAGES = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "json",
  "css",
  "html",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
]);

const TOKEN_LIMIT = 16_384;
const RESULT_LIMIT_BYTES = 128 * 1024;

/** Keep the most useful early semantic tokens and never exceed the host result budget. */
function boundedTokens(tokens) {
  const ranked = [...tokens].sort(
    (a, b) =>
      Number(b.type !== "variable") - Number(a.type !== "variable") ||
      Number(b.type === "keyword" || b.type === "string" || b.type === "comment") -
        Number(a.type === "keyword" || a.type === "string" || a.type === "comment") ||
      Number(b.end - b.start > 32) - Number(a.end - a.start > 32) ||
      a.start - b.start,
  );
  const selected = [];
  let bytes = Buffer.byteLength('{"tokens":[]}', "utf8");
  for (const token of ranked) {
    if (selected.length >= TOKEN_LIMIT) break;
    const tokenBytes = Buffer.byteLength(JSON.stringify(token), "utf8");
    const separator = selected.length ? 1 : 0;
    if (bytes + tokenBytes + separator > RESULT_LIMIT_BYTES) continue;
    selected.push(token);
    bytes += tokenBytes + separator;
  }
  return selected.sort((a, b) => a.start - b.start || a.end - b.end);
}

function tokenize(source, extensions, mode = "inline") {
  const tokens = [];
  let i = 0;
  let quote = "";
  let quoteStart = 0;
  let comment = false;
  let commentStart = 0;
  let blockComment = false;
  let blockCommentStart = 0;
  const extension = extensions[0] ?? "";
  const slashComment =
    ["js", "jsx", "mjs", "cjs", "ts", "tsx", "go", "java", "c", "h", "cpp", "hpp"].includes(
      extension,
    ) || extensions.some((value) => ["rs"].includes(value));
  const hashComment = ["py"].includes(extension);
  while (i < source.length) {
    const char = source[i];
    if (comment) {
      if (char === "\n") {
        tokens.push({ start: commentStart, end: i, type: "comment" });
        comment = false;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (blockComment) {
      if (char === "*" && source[i + 1] === "/") {
        i += 2;
        tokens.push({ start: blockCommentStart, end: i, type: "comment" });
        blockComment = false;
      } else i++;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        i = Math.min(source.length, i + 2);
        continue;
      }
      if (char === quote) {
        i++;
        tokens.push({ start: quoteStart, end: i, type: "string" });
        quote = "";
        continue;
      }
      if (char === "\n" && quote !== "`") {
        tokens.push({ start: quoteStart, end: i, type: "invalid" });
        quote = "";
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (slashComment && char === "/" && source[i + 1] === "/") {
      comment = true;
      commentStart = i;
      i += 2;
      continue;
    }
    if (slashComment && char === "/" && source[i + 1] === "*") {
      blockComment = true;
      blockCommentStart = i;
      i += 2;
      continue;
    }
    if (hashComment && char === "#") {
      comment = true;
      commentStart = i;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || (char === "`" && ["js", "ts"].includes(extension))) {
      quote = char;
      quoteStart = i;
      i++;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      comment = true;
      commentStart = i;
      i += 2;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = i;
      while (i < source.length && /[0-9a-fA-F_xX.eE+-]/.test(source[i])) i++;
      tokens.push({ start, end: i, type: "number" });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      const word = source.slice(start, i);
      if (KEYWORDS.has(word)) tokens.push({ start, end: i, type: "keyword" });
      else if (source[i] === "(") tokens.push({ start, end: i, type: "function" });
      else tokens.push({ start, end: i, type: "variable" });
      continue;
    }
    i++;
  }
  if (comment) tokens.push({ start: commentStart, end: i, type: "comment" });
  if (blockComment) tokens.push({ start: blockCommentStart, end: i, type: "comment" });
  if (quote) tokens.push({ start: quoteStart, end: i, type: "invalid" });
  // A window is intentionally approximate: comments/templates that start
  // before the window may be classified from the visible fragment only.
  return boundedTokens(
    tokens.filter(
      (token) => token.end > token.start && (mode !== "window" || token.end <= source.length),
    ),
  );
}

function extensionFromPath(path, extensions) {
  const name =
    String(path ?? "")
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase() ?? "";
  return extensions.find((value) => name.endsWith(`.${value}`)) ?? extensions[0] ?? "";
}

function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("invalid input");
  if (input.mode === "window") {
    if (
      input.source !== null ||
      !input.range ||
      !Number.isSafeInteger(input.range.offset) ||
      !Number.isSafeInteger(input.range.length) ||
      input.range.offset < 0 ||
      input.range.length < 1 ||
      input.range.length > 32 * 1024
    )
      throw new Error("invalid window");
  } else {
    if (typeof input.source !== "string") throw new Error("source must be a string");
    if (Buffer.byteLength(input.source, "utf8") > 128 * 1024) throw new Error("source too large");
  }
  if (!Array.isArray(input.extensions)) throw new Error("extensions must be an array");
  if (!input.extensions.every((value) => typeof value === "string" && LANGUAGES.has(value)))
    throw new Error("unsupported extension");
  return input;
}

async function readWindow(input, host) {
  const { document, range } = input;
  let offset = range.offset;
  let text = "";
  while (offset < range.offset + range.length) {
    const page = await host.call("editor.readRange", {
      tabId: document.tabId,
      documentId: document.documentId,
      version: document.version,
      offset,
      limit: Math.min(16 * 1024, range.offset + range.length - offset),
    });
    text += page.text;
    if (page.nextOffset === null || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return text;
}

async function main() {
  const { createPlugin } = await import("./sdk.mjs");
  createPlugin({
    async run(command, input, host) {
      if (command !== "highlight") throw new Error("unsupported command");
      const { source, extensions, mode = "inline" } = validateInput(input);
      const language = extensionFromPath(input.document?.path, extensions);
      const text = mode === "window" ? await readWindow(input, host) : source;
      return { tokens: tokenize(text, [language], mode) };
    },
  });
}
main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
