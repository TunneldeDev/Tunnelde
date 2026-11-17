import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api/ipc";
import * as ipc from "@/lib/api/ipc";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useEditors } from "@/store/editors";
import { usePluginSecurity } from "@/store/pluginSecurity";
import {
  editorSyntaxMatches,
  parseSyntaxResult,
  syntaxProviders,
  syntaxSegments,
  SYNTAX_TOKEN_LIMIT,
} from "@/lib/plugins/syntax";
import { runSyntaxHighlighting } from "@/lib/plugins/syntaxRunner";

const plugin = {
  id: "syntax",
  runtimeId: "boot:1",
  name: "Syntax",
  runtime: "node",
  status: "running",
  permissions: ["editor.read"],
  fingerprint: "first",
  views: [],
  commands: [
    { id: "highlight", title: "Highlight", editor: { extensions: ["js", "ts"], syntax: true } },
  ],
} as unknown as PluginInfo;
const provider = {
  id: "syntax",
  command: "highlight",
  title: "Syntax: Highlight",
  extensions: ["js", "ts"],
};
const document = {
  tabId: "editor:syntax",
  documentId: "document-one",
  version: 3,
  path: "/src/main.js",
  name: "main.js",
  content: 'const answer = 42;\nconsole.log("hello"); // note\n',
  dirty: false,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
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
  usePlugins.setState({ items: [{ ...plugin }] });
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
    tokens: [
      { start: 0, end: 5, type: "keyword" },
      { start: 15, end: 17, type: "number" },
    ],
  });
});
describe("plugin syntax highlighting contracts", () => {
  it("selects only syntax-only commands and matches compound extensions", () => {
    expect(editorSyntaxMatches("/a/component.test.ts", ["test.ts", "ts"])).toBe(true);
    expect(editorSyntaxMatches("/a/ts", ["ts"])).toBe(true);
    expect(syntaxProviders("/a.js", [plugin])).toHaveLength(1);
    expect(
      syntaxProviders("/a.js", [
        {
          ...plugin,
          commands: [
            { id: "format", title: "Format", editor: { extensions: ["js"], format: true } },
            { id: "legacy", title: "Legacy", editor: { extensions: ["js"] } },
            {
              id: "both",
              title: "Both",
              editor: { extensions: ["js"], format: true, syntax: true },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("validates UTF-16 scalar boundaries, ordering, overlaps, closed token types and limits", () => {
    const text = "a😀b";
    expect(parseSyntaxResult({ tokens: [{ start: 0, end: 1, type: "keyword" }] }, text)).toEqual([
      { start: 0, end: 1, type: "keyword" },
    ]);
    for (const tokens of [
      [{ start: 0, end: 2, type: "keyword" }],
      [{ start: 2, end: 3, type: "keyword" }],
      [{ start: 2, end: 1, type: "keyword" }],
      [{ start: 0, end: 1, type: "script" }],
      [
        { start: 0, end: 1, type: "keyword" },
        { start: 1, end: 2, type: "number" },
      ],
      [{ start: 0, end: 1, type: "keyword", html: "<b>" }],
    ])
      expect(() => parseSyntaxResult({ tokens }, text)).toThrow();
    expect(() =>
      parseSyntaxResult(
        {
          tokens: Array.from({ length: SYNTAX_TOKEN_LIMIT + 1 }, (_, i) => ({
            start: i,
            end: i + 1,
            type: "number",
          })),
        },
        "x".repeat(SYNTAX_TOKEN_LIMIT + 1),
      ),
    ).toThrow();
    expect(() => parseSyntaxResult({ tokens: [], css: "color:red" }, text)).toThrow();
  });

  it("renders semantic segments without interpreting markup", () => {
    const text = '<script>alert("x")</script>\nconst value = 1;';
    expect(
      syntaxSegments(text, [
        { start: 0, end: 8, type: "keyword" },
        { start: 41, end: 42, type: "constant" },
      ]),
    ).toEqual([
      { text: "<script>", type: "keyword" },
      { text: 'alert("x")</script>\nconst value =', type: null },
      { text: " ", type: "constant" },
      { text: "1;", type: null },
    ]);
  });

  it("invokes one running provider with document identity and applies no writes", async () => {
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toEqual([
      { start: 0, end: 5, type: "keyword" },
      { start: 15, end: 17, type: "number" },
    ]);
    expect(api.pluginRun).toHaveBeenCalledWith(
      "syntax",
      "highlight",
      expect.objectContaining({
        source: document.content,
        document: expect.objectContaining({ documentId: document.documentId, version: 3 }),
      }),
      "boot:1",
    );
  });

  it("never starts, prompts or sends text without an existing grant", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] });
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toBeNull();
    usePlugins.setState({ items: [{ ...plugin }] });
    usePluginSecurity.setState((state) => ({ state: { ...state.state, grants: {} } }));
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toBeNull();
    expect(api.pluginRun).not.toHaveBeenCalled();
  });

  it("discards stale, revoked, stopped and cancelled results", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const pending = deferred<unknown>();
    vi.mocked(api.pluginRun).mockReturnValue(pending.promise);
    const controller = new AbortController();
    const operation = runSyntaxHighlighting({ provider, document }, controller.signal);
    await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
    usePlugins.setState({ items: [{ ...plugin, runtimeId: "boot:2" }] });
    pending.resolve({ tokens: [{ start: 0, end: 1, type: "keyword" }] });
    expect(await operation).toBeNull();

    vi.mocked(api.pluginRun).mockResolvedValueOnce({
      tokens: [{ start: 0, end: 1, type: "keyword" }],
    });
    controller.abort();
    expect(await runSyntaxHighlighting({ provider, document }, controller.signal)).toBeNull();
    usePluginSecurity.setState((state) => ({ state: { ...state.state, grants: {} } }));
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toBeNull();
  });

  it("returns plain fallback for malformed, oversized, timed-out and stopped providers", async () => {
    vi.mocked(api.pluginRun).mockResolvedValueOnce({
      tokens: [{ start: 0, end: 999, type: "keyword" }],
    });
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toBeNull();
    vi.mocked(api.pluginRun).mockRejectedValueOnce(new Error("plugin.timeout"));
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toBeNull();
    usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] });
    expect(
      await runSyntaxHighlighting({ provider, document }, new AbortController().signal),
    ).toBeNull();
    expect(
      await runSyntaxHighlighting(
        { provider, document: { ...document, content: "x".repeat(128 * 1024 + 1) } },
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(api.pluginRun).toHaveBeenCalledTimes(2);
  });
});
