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
