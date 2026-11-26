import { useCallback, useEffect, useMemo, useState } from "react";
import type { SyntaxDocumentSnapshot } from "@/features/editor/syntax/useEditorSyntax";
import type { EditorVisibleRange } from "@/features/editor/syntax/useCodeEditorSyntax";
import { bufferedViewport } from "@/features/editor/syntax/syntaxViewport";
import type { SyntaxToken } from "@/lib/plugins/syntax";
import { SYNTAX_WINDOW_MAX_UTF16 } from "@/lib/plugins/syntaxProtocol";

export interface PreviewSyntaxSource {
  key: string;
  /** Tokens are relative to the bounded source range, never to another document. */
  highlight(
    document: SyntaxDocumentSnapshot,
    range: EditorVisibleRange,
    signal: AbortSignal,
  ): Promise<readonly SyntaxToken[] | null>;
}

/** Presentation-only adapter shared by Quick Look, docked and detached previews. */
export function usePreviewSyntax(
  document: SyntaxDocumentSnapshot,
  source: PreviewSyntaxSource | undefined,
  active: boolean,
) {
  const [visible, setVisible] = useState<EditorVisibleRange | null>(null);
  const [rendered, setRendered] = useState<{
    documentId: string;
    key: string;
    tokens: readonly SyntaxToken[];
  } | null>(null);
  const onVisibleRangeSettled = useCallback(
    (range: EditorVisibleRange) => {
      setVisible((previous) =>
        previous &&
        previous.documentId === range.documentId &&
        previous.version === range.version &&
        previous.from <= range.from &&
        previous.to >= Math.min(range.to, range.from + SYNTAX_WINDOW_MAX_UTF16)
          ? previous
          : bufferedViewport(range, document.content),
      );
    },
    [document.content],
  );
  const range = visible?.documentId === document.documentId ? visible : null;
  const highlight = source?.highlight;
  const key = source?.key;
  useEffect(() => {
    if (!active || !highlight || !key || !range || range.to <= range.from) return;
    const lifetime = new AbortController();
    const timer = setTimeout(() => {
      void highlight(document, range, lifetime.signal)
        .then((tokens) => {
          if (lifetime.signal.aborted || !tokens) return;
          setRendered({
            documentId: document.documentId,
            key,
            tokens: tokens.map((token) => ({
              ...token,
              start: token.start + range.from,
              end: token.end + range.from,
            })),
          });
        })
        .catch(() => {});
    }, 220);
    return () => {
      clearTimeout(timer);
      lifetime.abort();
    };
  }, [active, highlight, key, range, document]);
  const tokens = useMemo(
    () =>
      active && key && rendered?.key === key && rendered.documentId === document.documentId
        ? rendered.tokens
        : [],
    [active, key, rendered, document.documentId],
  );
  return { tokens, onVisibleRangeSettled };
}
