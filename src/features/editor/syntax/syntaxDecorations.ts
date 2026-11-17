import type { SyntaxToken } from "@/lib/plugins/syntax";

export interface SyntaxDecoration {
  start: number;
  end: number;
  type: SyntaxToken["type"];
}

export interface SyntaxDecorationWindow {
  documentId: string;
  version: number;
  offset: number;
  length: number;
  tokens: readonly SyntaxDecoration[];
}

/**
 * Translate window-local plugin tokens to absolute offsets for a CodeMirror
 * `Decoration.mark` consumer. Tokens have already passed host validation, but
 * this final projection is deliberately defensive and never produces a range
 * outside the requested window.
 */
export function absoluteSyntaxDecorations(window: SyntaxDecorationWindow): SyntaxDecoration[] {
  const end = window.offset + window.length;
  let previousEnd = window.offset;
  return window.tokens.flatMap((token) => {
    const start = window.offset + token.start;
    const tokenEnd = window.offset + token.end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(tokenEnd) ||
      start < previousEnd ||
      tokenEnd <= start ||
      tokenEnd > end
    )
      return [];
    previousEnd = tokenEnd;
    return [{ start, end: tokenEnd, type: token.type }];
  });
}

/** Host-owned class names only. CM adapters must not accept plugin classes. */
export function syntaxDecorationClass(type: SyntaxToken["type"]): string {
  return `td-syntax--${type}`;
}
