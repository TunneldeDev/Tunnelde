import { syntaxScalarBoundary } from "@/lib/plugins/syntax";
import { SYNTAX_WINDOW_MAX_UTF16 } from "@/lib/plugins/syntaxProtocol";
import type { EditorVisibleRange } from "./useCodeEditorSyntax";

/** Keep a bounded buffer on both sides, so ordinary scrolling needs no new call.
 * Large viewports retain their requested start within the protocol cap. */
export function bufferedViewport(range: EditorVisibleRange, content: string): EditorVisibleRange {
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
