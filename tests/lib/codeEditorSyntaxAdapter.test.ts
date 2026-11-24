import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useEditors } from "@/store/editors";
import { useCodeEditorSyntax } from "@/features/editor/syntax/useCodeEditorSyntax";
import type { SyntaxDocumentSnapshot } from "@/features/editor/syntax/useEditorSyntax";

const plugin = {
  id: "syntax",
  runtimeId: "boot:1",
  name: "Syntax",
  runtime: "node",
  status: "running",
  permissions: ["editor.read"],
  fingerprint: "first",
  views: [],
  commands: [{ id: "highlight", title: "Highlight", editor: { extensions: ["js"], syntax: true } }],
} as unknown as PluginInfo;
const content = `${"const value = 42; // note\n".repeat(1400)}${"😀".repeat(100_000)}`;
const document: SyntaxDocumentSnapshot = {
  tabId: "editor:cm",
  documentId: "document-cm",
  version: 9,
  path: "/large.js",
  name: "large.js",
  content,
  dirty: false,
};
beforeEach(() => {
  useEditors.getState().discard(document.tabId);
  useEditors.setState({
    entries: {
      [document.tabId]: {
        tabId: document.tabId,
        documentId: document.documentId,
        version: document.version,
        sessionId: null,
        path: document.path,
        name: document.name,
        content: document.content,
        baseline: document.content,
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  usePlugins.setState({ items: [{ ...plugin }], stoppingIds: [] });
  usePluginSecurity.setState({
    state: {
      restricted: false,
      cliLocked: false,
      recoverySuggested: false,
      reason: null,
      grants: { syntax: ["editor.read"] },
    },
  });
  vi.spyOn(api, "pluginRun").mockResolvedValue({
    tokens: [{ start: 0, end: 5, type: "keyword" }],
  });
});
describe("CodeEditorSurface syntax adapter", () => {
  it("returns identity-bound absolute tokens for a settled viewport window", async () => {
    const { result } = renderHook(() => useCodeEditorSyntax(document, true));
    act(() =>
      result.current.onVisibleRangeSettled({
        from: 20_000,
        to: 52_000,
        documentId: document.documentId,
        version: document.version,
      }),
    );
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.tokens).toEqual([{ start: 20_000, end: 20_005, type: "keyword" }]);
    expect(result.current.tokensDocumentId).toBe(document.documentId);
    expect(result.current.tokensVersion).toBe(document.version);
  });

  it("keeps existing colors until a replacement viewport result is ready", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCodeEditorSyntax(document, true));
      const settle = (from: number, to: number) =>
        act(() =>
          result.current.onVisibleRangeSettled({
            from,
            to,
            documentId: document.documentId,
            version: document.version,
          }),
        );
      settle(0, 32_000);
      await act(() => vi.advanceTimersByTimeAsync(300));
      const previous = result.current.tokens;
      expect(previous).toEqual([{ start: 0, end: 5, type: "keyword" }]);
      let resolve!: (value: { tokens: { start: number; end: number; type: string }[] }) => void;
      vi.mocked(api.pluginRun).mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      settle(20_000, 52_000);
      expect(result.current.tokens).toEqual(previous);
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(result.current.tokens).toEqual(previous);
      await act(async () => resolve({ tokens: [{ start: 0, end: 5, type: "keyword" }] }));
      expect(result.current.tokens).toEqual([{ start: 20_000, end: 20_005, type: "keyword" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preloads around the viewport and reuses it for nearby scrolling", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCodeEditorSyntax(document, true));
      const settle = (from: number, to: number) =>
        act(() =>
          result.current.onVisibleRangeSettled({
            from,
            to,
            documentId: document.documentId,
            version: document.version,
          }),
        );
      settle(10_000, 12_000);
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(vi.mocked(api.pluginRun).mock.calls[0]?.[2]).toMatchObject({
        mode: "window",
        range: { offset: 0, length: 32_768 },
      });
      const previous = result.current.tokens;
      settle(12_000, 14_000);
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(api.pluginRun).toHaveBeenCalledOnce();
      expect(result.current.tokens).toBe(previous);
      settle(40_000, 42_000);
      expect(result.current.tokens).toBe(previous);
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(api.pluginRun).toHaveBeenCalledTimes(2);
      const range = vi.mocked(api.pluginRun).mock.calls[1]?.[2]?.range as {
        offset: number;
        length: number;
      };
      expect(range.offset).toBeLessThan(40_000);
      expect(range.offset + range.length).toBeGreaterThan(42_000);
      expect(range.length).toBeLessThanOrEqual(32_768);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps buffered windows within the UTF-16 cap and off surrogate pairs", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCodeEditorSyntax(document, true));
      act(() =>
        result.current.onVisibleRangeSettled({
          from: 70_001,
          to: 72_001,
          documentId: document.documentId,
          version: document.version,
        }),
      );
      await act(() => vi.advanceTimersByTimeAsync(300));
      const range = vi.mocked(api.pluginRun).mock.calls[0]?.[2]?.range as {
        offset: number;
        length: number;
      };
      expect(range.length).toBeLessThanOrEqual(32_768);
      expect(range.offset).toBeLessThanOrEqual(70_001);
      expect(range.offset + range.length).toBeGreaterThanOrEqual(72_001);
      // The fixture's prefix is 36,400 ASCII units followed by emoji pairs.
      expect((range.offset - 36_400) % 2).toBe(0);
      expect((range.offset + range.length - 36_400) % 2).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not request or render syntax while inactive", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCodeEditorSyntax(document, enabled),
      { initialProps: { enabled: false } },
    );
    act(() =>
      result.current.onVisibleRangeSettled({
        from: 0,
        to: 32_000,
        documentId: document.documentId,
        version: document.version,
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.pluginRun).not.toHaveBeenCalled();
    expect(result.current.tokens).toEqual([]);
    rerender({ enabled: true });
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
  });

  it("clears tokens during composition and after provider revocation", async () => {
    const { result, rerender } = renderHook(
      ({ composing }) => useCodeEditorSyntax(document, true, composing),
      { initialProps: { composing: false } },
    );
    act(() =>
      result.current.onVisibleRangeSettled({
        from: 0,
        to: 32_000,
        documentId: document.documentId,
        version: document.version,
      }),
    );
    await vi.waitFor(() => expect(result.current.tokens).toHaveLength(1));
    rerender({ composing: true });
    expect(result.current.tokens).toEqual([]);
    rerender({ composing: false });
    act(() => usePlugins.setState({ items: [] }));
    expect(result.current.tokens).toEqual([]);
  });

  it("does not accept a viewport from a stale document identity", () => {
    const { result } = renderHook(() => useCodeEditorSyntax(document, true));
    act(() =>
      result.current.onVisibleRangeSettled({
        from: 0,
        to: 32_000,
        documentId: "old-document",
        version: document.version,
      }),
    );
    expect(api.pluginRun).not.toHaveBeenCalled();
    expect(result.current.tokens).toEqual([]);
  });
});
