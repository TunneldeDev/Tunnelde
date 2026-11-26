import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  usePreviewSyntax,
  type PreviewSyntaxSource,
} from "@/features/sftp/preview/usePreviewSyntax";
import type { SyntaxToken } from "@/lib/plugins/syntax";

it("reuses buffered preview colors while scrolling and fences inactive or replaced documents", async () => {
  vi.useFakeTimers();
  try {
    const document = {
      tabId: "preview:test",
      documentId: "first",
      version: 0,
      path: "/sample.ts",
      name: "sample.ts",
      content: "const value = 1;\n".repeat(20_000),
      dirty: false,
    };
    const tokens: SyntaxToken[] = [{ start: 0, end: 5, type: "keyword" }];
    const highlight = vi.fn<PreviewSyntaxSource["highlight"]>().mockResolvedValue(tokens);
    const source: PreviewSyntaxSource = { key: "runtime:1", highlight };
    const { result, rerender } = renderHook(
      ({ doc, active }) => usePreviewSyntax(doc, source, active),
      { initialProps: { doc: document, active: true } },
    );
    const settle = (from: number, to: number) =>
      act(() =>
        result.current.onVisibleRangeSettled({
          from,
          to,
          documentId: document.documentId,
          version: 0,
        }),
      );
    settle(10_000, 12_000);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.tokens).toEqual(tokens);
    const previous = result.current.tokens;
    settle(12_000, 14_000);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(highlight).toHaveBeenCalledOnce();
    expect(result.current.tokens).toBe(previous);
    let finish!: (value: SyntaxToken[] | null) => void;
    highlight.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    settle(50_000, 52_000);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.tokens).toBe(previous);
    rerender({ doc: { ...document, documentId: "replacement" }, active: true });
    await act(async () => finish(tokens));
    expect(result.current.tokens).toEqual([]);
    rerender({ doc: document, active: false });
    expect(result.current.tokens).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
