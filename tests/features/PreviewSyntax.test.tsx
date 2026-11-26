import "@/i18n/i18n";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { TextPreview } from "@/features/sftp/TextPreview";
import { previewSyntaxSource } from "@/features/sftp/preview/previewSyntax";
import type { PreviewReadSnapshot, PreviewReadSource } from "@/features/sftp/preview/readSource";
import { api } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useEditors } from "@/store/editors";
import type { PreviewFile } from "@/store/filePreview";
import { plugin } from "../fixtures/plugins";

const syntaxPlugin = {
  ...plugin,
  id: "syntax",
  runtimeId: "syntax:1",
  status: "running" as const,
  permissions: ["editor.read"],
  commands: [
    { id: "highlight", title: "Highlight", editor: { syntax: true, extensions: ["ts", "md"] } },
  ],
};
function readSource(content: string) {
  let read: PreviewReadSnapshot = { status: "ready", value: { content, encoding: "utf-8" } };
  return {
    source: {
      snapshot: () => read,
      subscribe: () => () => {},
      retain: vi.fn(() => () => {}),
      fail: vi.fn(),
    } as PreviewReadSource,
    retire() {
      read = { status: "unavailable" };
    },
  };
}
beforeEach(() => {
  usePlugins.setState({ items: [syntaxPlugin], stoppingIds: [] });
  usePluginSecurity.setState({
    state: {
      restricted: false,
      cliLocked: false,
      recoverySuggested: false,
      reason: null,
      grants: { syntax: ["editor.read"] },
    },
  });
  vi.spyOn(api, "pluginRun").mockResolvedValue({ tokens: [{ start: 0, end: 5, type: "keyword" }] });
});

it.each<PreviewFile["source"]>([{ kind: "local" }, { kind: "remote", sessionId: "ssh-preview" }])(
  "highlights supplied %j preview text without creating an editable buffer",
  async (source) => {
    const entries = useEditors.getState().entries;
    const read = readSource("const answer = 42;");
    const ui = render(
      <TextPreview
        file={{ path: "/sample.ts", line: 0, column: 0, source }}
        source={read.source}
      />,
    );
    await waitFor(() =>
      expect(ui.container.querySelector(".cm-editor-token-keyword")?.textContent).toBe("const"),
    );
    expect(api.pluginRun).toHaveBeenCalledWith(
      "syntax",
      "highlight",
      expect.objectContaining({ mode: "inline", source: "const answer = 42;" }),
      "syntax:1",
    );
    expect(useEditors.getState().entries).toBe(entries);
    const editor = EditorView.findFromDOM(screen.getByRole("textbox"))!;
    expect(editor.state.readOnly).toBe(true);
    editor.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect(editor.state.doc.toString()).toBe("const answer = 42;");
    act(() => usePlugins.setState({ stoppingIds: ["syntax"] }));
    expect(ui.container.querySelector(".cm-editor-token-keyword")).toBeNull();
  },
);

it("clears colors when the existing permission grant is revoked", async () => {
  const read = readSource("const value = 1;");
  const ui = render(
    <TextPreview
      file={{ path: "/sample.ts", line: 0, column: 0, source: { kind: "local" } }}
      source={read.source}
    />,
  );
  await waitFor(() => expect(ui.container.querySelector(".cm-editor-token-keyword")).toBeTruthy());
  act(() =>
    usePluginSecurity.setState({ state: { ...usePluginSecurity.getState().state, grants: {} } }),
  );
  expect(ui.container.querySelector(".cm-editor-token-keyword")).toBeNull();
});

it("sends a bounded inline window from a large preview and rejects a retired read", async () => {
  const content = "const value = 1;\n".repeat(20_000);
  const read = readSource(content);
  const syntax = previewSyntaxSource("/large.ts", read.source)!;
  const document = {
    tabId: "preview:one",
    documentId: "preview-document",
    version: 0,
    path: "/large.ts",
    name: "large.ts",
    content,
    dirty: false,
  };
  const range = { from: 100_000, to: 132_768, documentId: document.documentId, version: 0 };
  let finish!: (value: unknown) => void;
  vi.mocked(api.pluginRun).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = syntax.highlight(document, range, new AbortController().signal);
  await vi.waitFor(() => expect(api.pluginRun).toHaveBeenCalledOnce());
  expect(vi.mocked(api.pluginRun).mock.calls[0]?.[2]).toMatchObject({
    mode: "inline",
    source: content.slice(range.from, range.to),
  });
  read.retire();
  finish({ tokens: [{ start: 0, end: 5, type: "keyword" }] });
  expect(await pending).toBeNull();
});

it("leaves text usable when no authorized provider is running", async () => {
  usePluginSecurity.setState({ state: { ...usePluginSecurity.getState().state, grants: {} } });
  const read = readSource("const plain = true;");
  render(
    <TextPreview
      file={{ path: "/sample.ts", line: 0, column: 0, source: { kind: "local" } }}
      source={read.source}
    />,
  );
  expect(screen.getByRole("textbox").textContent).toBe("const plain = true;");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(api.pluginRun).not.toHaveBeenCalled();
});
