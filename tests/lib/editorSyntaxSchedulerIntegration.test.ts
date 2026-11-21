import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useEditors } from "@/store/editors";
import { useEditorSyntax } from "@/features/editor/syntax/useEditorSyntax";
import { pendingSyntaxCalls } from "@/lib/plugins/syntaxScheduler";

const plugin = {
  id: "syntax",
  runtimeId: "boot:scheduler",
  name: "Syntax",
  runtime: "node",
  status: "running",
  permissions: ["editor.read"],
  fingerprint: "scheduler",
  views: [],
  commands: [{ id: "highlight", title: "Highlight", editor: { extensions: ["js"], syntax: true } }],
} as unknown as PluginInfo;
const content = "const value = 42;\n".repeat(100);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
function doc(text: string, version: number) {
  return {
    tabId: "editor:scheduler",
    documentId: "document-scheduler",
    version,
    path: "/file.js",
    name: "file.js",
    content: text,
    dirty: false,
  };
}
beforeEach(() => {
  useEditors.getState().discard("editor:scheduler");
  useEditors.setState({
    entries: {
      "editor:scheduler": {
        tabId: "editor:scheduler",
        documentId: "document-scheduler",
        version: 1,
        sessionId: null,
        path: "/file.js",
        name: "file.js",
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
});
describe("syntax hook inflight coalescing", () => {
  it("bounds real calls across repeated edits and highlights the latest state", async () => {
    const first = deferred<unknown>();
    const latest = deferred<unknown>();
    vi.spyOn(api, "pluginRun")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) =>
        useEditorSyntax({ document: doc(text, 1), composing: false, enabled: true }),
      { initialProps: { text: content } },
    );
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
    rerender({ text: `${content}const next = 1;\n` });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    rerender({ text: `${content}const next = 2;\n` });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    rerender({ text: `${content}const next = 3;\n` });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(api.pluginRun).toHaveBeenCalledOnce();
    expect(pendingSyntaxCalls("syntax:boot:scheduler")).toBe(2);
    first.resolve({ tokens: [{ start: 0, end: 5, type: "keyword" }] });
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(2));
    latest.resolve({ tokens: [{ start: 0, end: 5, type: "keyword" }] });
    await vi.waitFor(() => expect(result.current.highlighted).toBe(true));
    expect(pendingSyntaxCalls("syntax:boot:scheduler")).toBe(0);
  });

  it("does not free the active slot on unmount and can resume after remount", async () => {
    const pending = deferred<unknown>();
    vi.spyOn(api, "pluginRun").mockReturnValueOnce(pending.promise);
    const first = renderHook(() =>
      useEditorSyntax({ document: doc(content, 1), composing: false, enabled: true }),
    );
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
    first.unmount();
    expect(pendingSyntaxCalls("syntax:boot:scheduler")).toBe(1);
    pending.resolve({ tokens: [{ start: 0, end: 5, type: "keyword" }] });
    await vi.waitFor(() => expect(pendingSyntaxCalls("syntax:boot:scheduler")).toBe(0));
    vi.spyOn(api, "pluginRun").mockResolvedValueOnce({
      tokens: [{ start: 0, end: 5, type: "keyword" }],
    });
    const second = renderHook(() =>
      useEditorSyntax({ document: doc(content, 1), composing: false, enabled: true }),
    );
    await vi.waitFor(() => expect(second.result.current.highlighted).toBe(true));
  });
});
