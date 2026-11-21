import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import * as ipc from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useEditors } from "@/store/editors";
import { useEditorSyntax } from "@/features/editor/syntax/useEditorSyntax";

const base = {
  runtimeId: "boot:1",
  name: "Syntax",
  runtime: "node",
  status: "running",
  permissions: ["editor.read"],
  fingerprint: "first",
  views: [],
  commands: [{ id: "highlight", title: "Highlight", editor: { extensions: ["js"], syntax: true } }],
} as unknown as PluginInfo;
const first = { ...base, id: "first" } as PluginInfo;
const second = { ...base, id: "second", runtimeId: "boot:2", fingerprint: "second" } as PluginInfo;
const content = "const value = 42;\n".repeat(100);
const document = {
  tabId: "editor:fallback",
  documentId: "document-fallback",
  version: 1,
  path: "/file.js",
  name: "file.js",
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
        content,
        baseline: content,
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  usePlugins.setState({ items: [{ ...first }, { ...second }], stoppingIds: [] });
  usePluginSecurity.setState({
    state: {
      restricted: false,
      cliLocked: false,
      recoverySuggested: false,
      reason: null,
      grants: { first: ["editor.read"], second: ["editor.read"] },
    },
  });
  vi.spyOn(api, "pluginRun").mockResolvedValue({ tokens: [{ start: 0, end: 5, type: "keyword" }] });
});
async function highlighted() {
  const { result } = renderHook(() =>
    useEditorSyntax({ document, composing: false, enabled: true }),
  );
  await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return result;
}
describe("syntax provider eligibility fallback", () => {
  it("skips a stopped first provider and invokes an authorized running second", async () => {
    usePlugins.setState({ items: [{ ...first, status: "stopped" }, { ...second }] });
    const result = await highlighted();
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[0]).toBe("second");
    expect(result.current.highlighted).toBe(true);
  });
  it("skips a revoked first provider and invokes an authorized second", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    usePluginSecurity.setState((state) => ({
      state: { ...state.state, grants: { second: ["editor.read"] } },
    }));
    await highlighted();
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[0]).toBe("second");
  });
  it("skips a stopping first provider and invokes an authorized second", async () => {
    usePlugins.setState({ items: [{ ...first }, { ...second }], stoppingIds: ["first"] });
    await highlighted();
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[0]).toBe("second");
  });
});
