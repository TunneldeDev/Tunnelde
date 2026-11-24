import { useCallback, useMemo, useState } from "react";
import { useEditorSyntax, type SyntaxDocumentSnapshot } from "./useEditorSyntax";
import { absoluteSyntaxDecorations } from "./syntaxDecorations";
import { syntaxScalarBoundary } from "@/lib/plugins/syntax";
import { SYNTAX_WINDOW_MAX_UTF16 } from "@/lib/plugins/syntaxProtocol";
import "./editorSyntax.css";

export interface EditorToken {
  start: number;
  end: number;
  type: string;
}

export interface EditorVisibleRange {
  from: number;
  to: number;
  documentId: string;
  version: number;
}

export interface CodeEditorSyntax {
  tokens: readonly EditorToken[];
  tokensDocumentId: string | null;
  tokensVersion: number | null;
  onVisibleRangeSettled: (range: EditorVisibleRange) => void;
}

/** CM and host CSS must use one semantic class vocabulary. */
export const syntaxDecorationClass = (type: string) => `cm-editor-token-${type}`;

/** Keep a bounded buffer on both sides, so ordinary scrolling needs no new call.
 * Large viewports retain their requested start within the protocol cap. */
function bufferedViewport(range: EditorVisibleRange, content: string): EditorVisibleRange {
  const length = range.to - range.from;
  if (length <= 0) return range;
  let from = range.from;
  if (length <= SYNTAX_WINDOW_MAX_UTF16 / 2) {
    const padding = Math.floor((SYNTAX_WINDOW_MAX_UTF16 - length) / 2);
    from = Math.max(0, from - padding);
    // Prefer a complete line for TextMate state, without exceeding the protocol cap.
    const lineStart = from === 0 ? 0 : content.lastIndexOf("\n", from - 1) + 1;
    if (range.to - lineStart <= SYNTAX_WINDOW_MAX_UTF16) from = lineStart;
  }
  if (!syntaxScalarBoundary(content, from)) from -= 1;
  let to = Math.min(
    content.length,
    from +
      (length <= SYNTAX_WINDOW_MAX_UTF16 / 2
        ? SYNTAX_WINDOW_MAX_UTF16
        : Math.min(length, SYNTAX_WINDOW_MAX_UTF16)),
  );
  if (!syntaxScalarBoundary(content, to)) to -= 1;
  return { ...range, from, to };
}

/**
 * Contract consumed by CodeEditorSurface. The hook owns authorization and
 * provider calls; CM owns viewport reporting and Decoration.mark rendering.
 */
export function useCodeEditorSyntax(
  document: SyntaxDocumentSnapshot | null,
  enabled: boolean,
  composing = false,
): CodeEditorSyntax {
  const [visible, setVisible] = useState<EditorVisibleRange | null>(null);
  const onVisibleRangeSettled = useCallback(
    (range: EditorVisibleRange) => {
      setVisible((current) =>
        current &&
        current.from <= range.from &&
        current.to >= Math.min(range.to, range.from + SYNTAX_WINDOW_MAX_UTF16) &&
        current.documentId === range.documentId &&
        current.version === range.version
          ? current
          : bufferedViewport(range, document?.content ?? ""),
      );
    },
    [document?.content],
  );
  const requestRange =
    visible &&
    document &&
    visible.documentId === document.documentId &&
    visible.version === document.version
      ? { offset: visible.from, length: Math.max(0, visible.to - visible.from) }
      : null;
  const syntax = useEditorSyntax({ document, composing, enabled, requestedRange: requestRange });
  const tokens = useMemo(
    () =>
      !syntax.highlighted
        ? []
        : syntax.range
          ? absoluteSyntaxDecorations({
              documentId: syntax.documentId ?? "",
              version: syntax.version ?? -1,
              offset: syntax.range.offset,
              length: syntax.range.length,
              tokens: syntax.tokens,
            })
          : syntax.tokens,
    [syntax.highlighted, syntax.documentId, syntax.version, syntax.range, syntax.tokens],
  );
  return {
    tokens,
    tokensDocumentId: tokens.length ? syntax.documentId : null,
    tokensVersion: tokens.length ? syntax.version : null,
    onVisibleRangeSettled,
  };
}
