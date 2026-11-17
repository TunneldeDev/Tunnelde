import type { SyntaxToken } from "./syntax";

export const SYNTAX_WINDOW_MAX_UTF16 = 32 * 1024;
export const SYNTAX_CONTEXT_PAGE_UTF16 = 16 * 1024;

export interface SyntaxDocumentMetadata {
  tabId: string;
  documentId: string;
  version: number;
  path: string;
  name: string;
}

export interface SyntaxInlineRequest {
  mode: "inline";
  source: string;
  document: SyntaxDocumentMetadata;
  extensions: string[];
  _locale: string;
}

export interface SyntaxWindowRequest {
  mode: "window";
  source: null;
  document: SyntaxDocumentMetadata;
  extensions: string[];
  range: { offset: number; length: number };
  _locale: string;
}

export type SyntaxProviderRequest = SyntaxInlineRequest | SyntaxWindowRequest;

export function syntaxWindow(offset: number, length: number): { offset: number; length: number } {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 1 ||
    length > SYNTAX_WINDOW_MAX_UTF16
  )
    throw new Error("invalid:syntaxWindow");
  return { offset, length };
}

/** Provider tokens remain relative to the requested window; CM projection adds offset. */
export interface SyntaxWindowResult {
  tokens: SyntaxToken[];
}
