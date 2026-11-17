import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useEditors } from "@/store/editors";
import { usePluginSecurity } from "@/store/pluginSecurity";
import {
  useEditorSyntax,
  type SyntaxDocumentSnapshot,
} from "@/features/editor/syntax/useEditorSyntax";

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
const large = (size = 320 * 1024) => {
  const base = "const value = 42; // note\n";
  return base.repeat(Math.ceil(size / base.length)).slice(0, size);
};
const document = (content = large()): SyntaxDocumentSnapshot => ({
  tabId: "editor:window",
  documentId: "document-window",
  version: 7,
  path: "/large.js",
  name: "large.js",
  content,
  dirty: false,
});
beforeEach(() => {
  const content = large();
  useEditors.getState().discard("editor:window");
  useEditors.setState({
    entries: {
      "editor:window": {
        tabId: "editor:window",
        documentId: "document-window",
        version: 7,
        sessionId: null,
        path: "/large.js",
        name: "large.js",
        content,
        baseline: content,
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
describe("windowed editor syntax", () => {
  it("does not send a large source and waits for a settled visible window", async () => {
    const content = large();
    const { rerender } = renderHook(
      ({ range }: { range: { offset: number; length: number } | null }) =>
        useEditorSyntax({
          document: document(content),
          composing: false,
          enabled: true,
          requestedRange: range,
        }),
      { initialProps: { range: null as { offset: number; length: number } | null } },
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(api.pluginRun).not.toHaveBeenCalled();
    rerender({ range: { offset: 120_000, length: 32_000 } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(api.pluginRun).toHaveBeenCalledOnce();
    expect(api.pluginRun).toHaveBeenCalledWith(
      "syntax",
      "highlight",
      expect.objectContaining({
        mode: "window",
        source: null,
        range: { offset: 120_000, length: 32_000 },
        document: expect.objectContaining({ documentId: "document-window", version: 7 }),
      }),
      "boot:1",
    );
  });

  it("idles after one result and requests only a newly settled window", async () => {
    vi.useFakeTimers();
    try {
      const content = large();
      const { rerender } = renderHook(
        ({ range }: { range: { offset: number; length: number } }) =>
          useEditorSyntax({
            document: document(content),
            composing: false,
            enabled: true,
            requestedRange: range,
          }),
        { initialProps: { range: { offset: 0, length: 32_000 } } },
      );
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(api.pluginRun).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(2_500));
      expect(api.pluginRun).toHaveBeenCalledOnce();
      rerender({ range: { offset: 32_000, length: 32_000 } });
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(api.pluginRun).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.pluginRun).mock.calls[1]?.[2]).toMatchObject({
        mode: "window",
        range: { offset: 32_000, length: 32_000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears rendered tokens on stale identity, revoke, stop and composing", async () => {
    {
      const content = large();
      usePlugins.setState({ items: [{ ...plugin, status: "running" }] });
      const requestedRange = { offset: 0, length: 32_000 };
      const { result, rerender } = renderHook(
        (props: { content: string; composing: boolean; enabled: boolean }) =>
          useEditorSyntax({
            document: document(props.content),
            composing: props.composing,
            enabled: props.enabled,
            requestedRange,
          }),
        { initialProps: { content, composing: false, enabled: true } },
      );
      await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(result.current.highlighted).toBe(true);
      rerender({ content: `${content.slice(0, -1)}x`, composing: false, enabled: true });
      expect(result.current.highlighted).toBe(false);
      await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(result.current.highlighted).toBe(true);
      rerender({ content, composing: true, enabled: true });
      expect(result.current.highlighted).toBe(false);
      rerender({ content, composing: false, enabled: false });
      expect(result.current.highlighted).toBe(false);
      act(() => {
        usePluginSecurity.setState((state) => ({ state: { ...state.state, grants: {} } }));
        rerender({ content, composing: false, enabled: true });
      });
      expect(result.current.highlighted).toBe(false);
      act(() => {
        usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] });
        rerender({ content, composing: false, enabled: true });
      });
      expect(result.current.highlighted).toBe(false);
    }
  });
});
