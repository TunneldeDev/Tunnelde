import { useCallback, useState } from "react";
import { useEditorSyntax, type SyntaxDocumentSnapshot } from "./useEditorSyntax";
import { absoluteSyntaxDecorations } from "./syntaxDecorations";
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
  const onVisibleRangeSettled = useCallback((range: EditorVisibleRange) => {
    setVisible((current) =>
      current &&
      current.from === range.from &&
      current.to === range.to &&
      current.documentId === range.documentId &&
      current.version === range.version
        ? current
        : range,
    );
  }, []);
  const requestRange =
    visible &&
    document &&
    visible.documentId === document.documentId &&
    visible.version === document.version
      ? { offset: visible.from, length: Math.max(0, visible.to - visible.from) }
      : null;
  const syntax = useEditorSyntax({ document, composing, enabled, requestedRange: requestRange });
  const tokens = !syntax.highlighted
    ? []
    : syntax.range
      ? absoluteSyntaxDecorations({
          documentId: syntax.documentId ?? "",
          version: syntax.version ?? -1,
          offset: syntax.range.offset,
          length: syntax.range.length,
          tokens: syntax.tokens,
        })
      : syntax.tokens;
  return {
    tokens,
    tokensDocumentId: tokens.length ? syntax.documentId : null,
    tokensVersion: tokens.length ? syntax.version : null,
    onVisibleRangeSettled,
  };
}
