import * as keyboardActions from "@/lib/keyboard/actions";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { EditorPage } from "@/features/editor/EditorPage";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import {
  beginEditorInput,
  editorDocument,
  replaceEditorDocument,
  useEditors,
  type EditorEntry,
} from "@/store/editors";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { api } from "@/lib/api/ipc";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import type { PluginInfo } from "@/lib/api/types";
import { useFormatting } from "@/lib/plugins/formatting";
import { EditorView } from "@codemirror/view";

function editorView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error("CM view not mounted");
  return view;
}
function editorText(element: HTMLElement): string {
  return editorView(element).state.doc.toString();
}
const editorBox = async (name = "draft.txt") => screen.findByRole("textbox", { name });

const entry: EditorEntry = {
  tabId: "editor",
  sessionId: "s1",
  path: "/draft.txt",
  name: "draft.txt",
  content: "\tunsaved draft\r\n\tsecond line\r\n",
  baseline: "original\r\n",
  encoding: "utf-8",
  bom: false,
  loading: false,
  saving: false,
  error: null,
};

afterEach(() => {
  cleanup();
  useEditors.getState().discard("editor");
});

beforeEach(() => {
  useEditors.getState().discard("editor");
  useEditors.setState({ entries: { editor: { ...entry } } });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useWorkspace.setState({ tabs: [] });
  useSsh.setState({ sessions: [] });
  usePlugins.setState({ items: [] });
  useFormatting.setState({ busy: [], picker: null });
});

describe("text encoding controls", () => {
  const choose = async (label: string, option: string) => {
    const control = screen.getByRole("button", { name: label });
    await act(async () => {
      fireEvent.click(control);
    });
    const item = await screen.findByRole("option", { name: option });
    await act(async () => {
      fireEvent.pointerDown(item);
      fireEvent.mouseDown(item);
      fireEvent.click(item);
    });
  };

  it("changes the save encoding for a dirty draft without replacing its buffer", async () => {
    vi.spyOn(api, "sftpReadText");
    render(<EditorPage tabId="editor" active />);
    const encoding = screen.getByRole("button", { name: "Save encoding" });
    expect(encoding.textContent).toContain("UTF-8");
    await choose("Save encoding", "UTF-16 LE");
    expect(api.sftpReadText).not.toHaveBeenCalled();
    expect(useEditors.getState().entries.editor).toMatchObject({
      content: entry.content,
      baseline: entry.baseline,
      encoding: "utf-16le",
      bom: true,
    });
    expect(editorText(await editorBox())).toBe(entry.content.replaceAll("\r\n", "\n"));
  });

  it("reopens clean bytes through the separate encoding action", async () => {
    useEditors.setState({
      entries: {
        editor: { ...entry, content: "clean", baseline: "clean" },
      },
    });
    vi.spyOn(api, "sftpReadText").mockResolvedValue({
      content: "旧版中文",
      size: 8,
      encoding: "gb18030",
      bom: false,
    });
    render(<EditorPage tabId="editor" active />);
    const encoding = screen.getByRole("button", { name: "Save encoding" });
    fireEvent.click(encoding);
    fireEvent.click(await screen.findByRole("button", { name: "Reopen with encoding…" }));
    await screen.findByRole("dialog", { name: "Reopen with encoding" });
    fireEvent.click(await screen.findByRole("button", { name: "GB18030" }));
    await waitFor(() =>
      expect(api.sftpReadText).toHaveBeenCalledWith("s1", "/draft.txt", "gb18030"),
    );
    expect(editorText(await editorBox())).toBe("旧版中文");
    expect(useEditors.getState().entries.editor).toMatchObject({
      content: "旧版中文",
      baseline: "旧版中文",
      encoding: "gb18030",
      bom: false,
    });
  });

  it("keeps byte reinterpretation unavailable while a draft is dirty", async () => {
    vi.spyOn(api, "sftpReadText");
    render(<EditorPage tabId="editor" active />);
    fireEvent.click(screen.getByRole("button", { name: "Save encoding" }));
    expect(screen.queryByRole("button", { name: "Reopen with encoding…" })).toBeNull();
    expect(api.sftpReadText).not.toHaveBeenCalled();
    expect(useEditors.getState().entries.editor?.content).toBe(entry.content);
  });

  it("retries a failed initial decode with the selected save encoding", async () => {
    useEditors.setState({
      entries: {
        editor: {
          ...entry,
          content: "",
          baseline: "",
          error: "The file could not be decoded with the selected text encoding",
          decodeError: true,
          baselineLoaded: false,
        },
      },
    });
    vi.spyOn(api, "sftpReadText").mockResolvedValue({
      content: "decoded",
      size: 7,
      encoding: "utf-16le",
      bom: true,
    });
    render(<EditorPage tabId="editor" active />);
    await choose("Reopen with encoding", "UTF-16 LE");
    await waitFor(() =>
      expect(api.sftpReadText).toHaveBeenCalledWith("s1", "/draft.txt", "utf-16le"),
    );
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("decoded"));
  });
});

it.each([null, "s1"])(
  "retries a failed open in the same tab with automatic encoding detection: %s",
  async (sessionId) => {
    const read = vi
      .spyOn(api, sessionId === null ? "localReadText" : "sftpReadText")
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue({ content: "loaded", size: 6, encoding: "gb18030", bom: false });
    await useEditors.getState().open("editor", sessionId, "/draft.txt");
    render(<EditorPage tabId="editor" active />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(editorText(await editorBox())).toBe("loaded");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(
      ...(sessionId === null ? ["/draft.txt", undefined] : [sessionId, "/draft.txt", undefined]),
    );
    expect(useEditors.getState().isDirty("editor")).toBe(false);
  },
);

describe("native file-save setup", () => {
  it("derives installation from the open remote document, keeps content intact and permits cancelling", async () => {
    let finish!: (value: boolean) => void;
    const setup = vi.spyOn(api, "sftpSetupNativeSave").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const save = vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
    render(<EditorPage tabId="editor" active />);
    const button = screen.getByRole("button", { name: /Enable recoverable saves|启用安全保存/ });
    fireEvent.click(button);
    expect(setup).toHaveBeenCalledWith("s1", "/draft.txt");
    expect(screen.getByRole("button", { name: /Setting up|正在初始化/ })).toHaveProperty(
      "disabled",
      true,
    );
    const textarea = await editorBox();
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    await act(async () => finish(false));
    expect(
      screen.getByRole("button", { name: /Enable recoverable saves|启用安全保存/ }),
    ).toHaveProperty("disabled", false);
    expect(useEditors.getState().entries.editor?.content).toBe(entry.content);
    expect(save).not.toHaveBeenCalled();
  });
  it("does not offer remote installation for a local document", () => {
    useEditors.setState({
      entries: { editor: { ...entry, sessionId: null, path: "C:/qa/draft.txt" } },
    });
    render(<EditorPage tabId="editor" active />);
    expect(
      screen.queryByRole("button", { name: /Enable recoverable saves|启用安全保存/ }),
    ).toBeNull();
  });
  it("keeps a setup error visible for its document and clears it when retrying", async () => {
    const setup = vi.spyOn(api, "sftpSetupNativeSave").mockRejectedValue({
      code: "validation",
      message: "editor.nativeDownloadFailed",
    });
    render(<EditorPage tabId="editor" active />);
    fireEvent.click(screen.getByRole("button", { name: /Enable recoverable saves|启用安全保存/ }));
    const failure = await screen.findByRole("alert");
    expect(failure.textContent).not.toContain("nativeDownloadFailed");
    expect(useEditors.getState().entries.editor?.content).toBe(entry.content);
    act(() => useEditors.setState({ entries: { editor: { ...entry, path: "/other.txt" } } }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => useEditors.setState({ entries: { editor: { ...entry } } }));
    expect(screen.getByRole("alert").textContent).toBe(failure.textContent);
    setup.mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: /Enable recoverable saves|启用安全保存/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("EditorPage syntax integration", () => {
  const syntaxPlugin = {
    id: "syntax-page",
    runtimeId: "boot:1",
    name: "Syntax",
    runtime: "node",
    status: "running",
    permissions: ["editor.read"],
    fingerprint: "first",
    views: [],
    commands: [
      { id: "highlight", title: "Highlight", editor: { extensions: ["txt"], syntax: true } },
    ],
  } as unknown as PluginInfo;

  const prepareSyntax = () => {
    useEditors.setState({
      entries: {
        editor: {
          ...entry,
          name: "bridge.txt",
          path: "/bridge.txt",
          content: "const value = 42;",
          baseline: "const value = 42;",
          documentId: "syntax-document",
          version: 0,
        },
      },
    });
    usePlugins.setState({ items: [{ ...syntaxPlugin }], stoppingIds: [] });
    usePluginSecurity.setState({
      state: {
        restricted: false,
        cliLocked: false,
        recoverySuggested: false,
        reason: null,
        grants: { "syntax-page": ["editor.read"] },
      },
    });
    vi.spyOn(api, "pluginRun").mockResolvedValue({
      tokens: [{ start: 0, end: 5, type: "keyword" }],
    });
  };

  it("renders provider tokens in the actual CM surface and skips inactive editors", async () => {
    prepareSyntax();
    const { rerender } = render(<EditorPage tabId="editor" active={false} />);
    const textarea = await editorBox("bridge.txt");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.pluginRun).not.toHaveBeenCalled();
    rerender(<EditorPage tabId="editor" active />);
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalled());
    await waitFor(() =>
      expect(textarea.querySelector(".cm-editor-token-keyword")?.textContent).toBe("const"),
    );
    fireEvent.compositionStart(textarea);
    await waitFor(() => expect(textarea.querySelector(".cm-editor-token-keyword")).toBeNull());
    fireEvent.compositionEnd(textarea);
    await waitFor(() =>
      expect(textarea.querySelector(".cm-editor-token-keyword")?.textContent).toBe("const"),
    );
  });
});

describe("editor formatting shortcuts", () => {
  const prepare = async () => {
    const json = {
      ...entry,
      name: "test.json",
      path: "/test.json",
      content: '{"a":1}',
      baseline: '{"a":1}',
    };
    useEditors.setState({ entries: { editor: json } });
    useWorkspace.setState({ activeId: "editor" });
    usePlugins.setState({
      items: [
        {
          id: "formatter",
          name: "Formatter",
          runtime: "node",
          status: "running",
          views: [],
          permissions: ["editor.read", "editor.write"],
          commands: [
            {
              id: "pretty",
              title: "Format",
              keybindings: ["Mod+Shift+F"],
              editor: { extensions: ["json"], format: true },
            },
          ],
        },
      ] as unknown as PluginInfo[],
    });
    vi.spyOn(api, "pluginRun").mockResolvedValue({ text: '{\n    "a": 1\n}' });
    vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
    render(<EditorPage tabId="editor" active />);
    return await editorBox("test.json");
  };

  it.each(["ctrlKey", "metaKey"] as const)(
    "formats with %s and supports one-step undo and redo",
    async (modifier) => {
      const textarea = await prepare();
      textarea.focus();
      fireEvent.keyDown(textarea, { key: "F", shiftKey: true, [modifier]: true });
      await waitFor(() => expect(editorText(textarea)).toBe('{\n    "a": 1\n}'));
      expect(api.sftpWriteText).not.toHaveBeenCalled();
      fireEvent.keyDown(textarea, { key: "z", [modifier]: true });
      await waitFor(() => expect(editorText(textarea)).toBe('{"a":1}'));
      fireEvent.keyDown(textarea, { key: "Z", shiftKey: true, [modifier]: true });
      await waitFor(() => expect(editorText(textarea)).toBe('{\n    "a": 1\n}'));
      fireEvent(
        textarea,
        new InputEvent("beforeinput", {
          inputType: "historyUndo",
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitFor(() => expect(editorText(textarea)).toBe('{"a":1}'));
    },
  );

  it("honors a customized binding without stealing the original content-search chord", async () => {
    const textarea = await prepare();
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          keyboardShortcuts: { "plugin.c.9.formatter.pretty": ["Mod+Alt+J"] },
        },
      }),
    );
    const original = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(textarea, original);
    expect(original.defaultPrevented).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "j", ctrlKey: true, altKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
  });

  it("runs both applicable plugin commands when their shortcuts conflict", async () => {
    const textarea = await prepare();
    act(() =>
      usePlugins.setState((state) => ({
        items: [...state.items, { ...state.items[0]!, id: "second", name: "Second" }],
      })),
    );
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.pluginRun).mock.calls.map((call) => call[0])).toEqual([
      "formatter",
      "second",
    ]);
  });

  it("blocks lower-priority editor plugins after accepting the preferred formatter", async () => {
    const textarea = await prepare();
    act(() => {
      usePlugins.setState((state) => ({
        items: [...state.items, { ...state.items[0]!, id: "second", name: "Second" }],
      }));
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          shortcutRules: {
            "plugin.c.6.second.pretty": { "Mod+Shift+F": { priority: 500, propagation: "block" } },
          },
        },
      });
    });
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[0]).toBe("second");
  });

  it("keeps a queued formatter bound to the editor when a shared workbench command changes tabs", async () => {
    const textarea = await prepare();
    const run = vi.spyOn(keyboardActions, "runWorkbenchCommand").mockImplementation(() => {
      useWorkspace.setState({ activeId: "other" });
      return true;
    });
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.pluginRun).mock.calls[0]?.[2]).toMatchObject({
      document: { tabId: "editor" },
    });
    expect(useEditors.getState().entries.editor?.content).toContain('"a": 1');
    run.mockRestore();
  });

  it("runs both matching editor commands contributed by one plugin in sequence", async () => {
    const textarea = await prepare();
    act(() =>
      usePlugins.setState((state) => ({
        items: state.items.map((item) => ({
          ...item,
          commands: [...item.commands, { ...item.commands[0]!, id: "second" }],
        })),
      })),
    );
    fireEvent.keyDown(textarea, { key: "F", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.pluginRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.pluginRun).mock.calls.map((call) => call[1])).toEqual([
      "pretty",
      "second",
    ]);
  });

  it("does not capture an editor plugin shortcut for an unsupported extension", async () => {
    const textarea = await prepare();
    act(() => useEditors.setState({ entries: { editor: { ...entry } } }));
    const event = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(textarea, event);
    expect(event.defaultPrevented).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
  });

  it("updates the format action as matching providers are installed, removed, or the file changes", async () => {
    await prepare();
    const label = /格式化文档|Format document/i;
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
    act(() => useEditors.setState({ entries: { editor: { ...entry } } }));
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    act(() => useEditors.setState({ entries: { editor: { ...entry, path: "/test.JSON" } } }));
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
    const plugins = usePlugins.getState().items;
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.queryByRole("button", { name: label })).toBeNull();
    act(() => usePlugins.setState({ items: plugins }));
    expect(screen.getByRole("button", { name: label })).toHaveProperty("disabled", false);
  });

  it("does not offer formatting for editor commands without a formatter contribution", () => {
    prepare();
    act(() =>
      usePlugins.setState((state) => ({
        items: state.items.map((plugin) => ({
          ...plugin,
          commands: plugin.commands.map((command) => ({
            ...command,
            editor: { extensions: ["json"], format: false },
          })),
        })),
      })),
    );
    expect(screen.queryByRole("button", { name: /格式化文档|Format document/i })).toBeNull();
  });

  it("retains the disabled progress action until an in-flight formatter finishes after uninstall", () => {
    prepare();
    act(() => useFormatting.setState({ busy: ["editor"] }));
    act(() => usePlugins.setState({ items: [] }));
    expect(screen.getByRole("button", { name: /正在格式化|Formatting/i })).toHaveProperty(
      "disabled",
      true,
    );
    act(() => useFormatting.setState({ busy: [] }));
    expect(
      screen.queryByRole("button", { name: /格式化文档|Format document|正在格式化|Formatting/i }),
    ).toBeNull();
  });

  it("does not capture keys from a different visible editor", async () => {
    prepare();
    const other = { ...entry, tabId: "other", path: "/other.txt", name: "other.txt" };
    act(() => useEditors.setState((state) => ({ entries: { ...state.entries, other } })));
    render(<EditorPage tabId="other" active={false} />);
    const event = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(screen.getByRole("textbox", { name: "other.txt" }), event);
    expect(event.defaultPrevented).toBe(false);
    expect(api.pluginRun).not.toHaveBeenCalled();
  });
});

describe("EditorPage undo selection", () => {
  const selection = (
    start: number,
    end = start,
    direction: "forward" | "backward" | "none" = "none",
  ) => ({ start, end, direction });

  const prepareHistory = async () => {
    useEditors.setState({
      entries: {
        editor: {
          ...entry,
          content: "abcdef",
          baseline: "abcdef",
          documentId: "document",
          version: 1,
        },
      },
    });
    render(<EditorPage tabId="editor" active />);
    return (await editorBox()) as HTMLTextAreaElement;
  };

  it("captures the pre-edit caret and restores it through shortcut undo and redo", async () => {
    const textarea = await prepareHistory();
    const view = editorView(textarea);
    view.focus();
    view.dispatch({ selection: { anchor: 3 } });
    fireEvent(
      textarea,
      new InputEvent("beforeinput", { inputType: "insertText", bubbles: true, cancelable: true }),
    );
    view.dispatch({ changes: { from: 3, to: 3, insert: "X" }, selection: { anchor: 4 } });
    await waitFor(() => expect(editorText(textarea)).toBe("abcXdef"));

    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("abcdef"));
    expect(editorView(textarea).state.selection.main.from).toBe(3);
    expect(editorView(textarea).state.selection.main.to).toBe(3);

    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("abcXdef"));
  });

  it("restores selection through the native beforeinput history path", async () => {
    const textarea = await prepareHistory();
    const view = editorView(textarea);
    view.focus();
    view.dispatch({ selection: { anchor: 3 } });
    beginEditorInput("editor", "insertText", selection(3));
    view.dispatch({ changes: { from: 3, to: 3, insert: "X" }, selection: { anchor: 4 } });
    await waitFor(() => expect(editorText(textarea)).toBe("abcXdef"));

    const nativeUndo = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(nativeUndo);
    expect(nativeUndo.defaultPrevented).toBe(true);
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("abcdef"));
    expect(editorView(textarea).state.selection.main.from).toBe(3);
  });

  it("restores a ranged selection direction after replacement undo", async () => {
    const textarea = await prepareHistory();
    const view = editorView(textarea);
    view.focus();
    view.dispatch({ selection: { anchor: 4, head: 1 } });
    fireEvent(
      textarea,
      new InputEvent("beforeinput", {
        inputType: "insertReplacementText",
        bubbles: true,
        cancelable: true,
      }),
    );
    view.dispatch({ changes: { from: 1, to: 4, insert: "Q" }, selection: { anchor: 2 } });
    await waitFor(() => expect(editorText(textarea)).toBe("aQef"));

    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("abcdef"));
    expect(editorView(textarea).state.selection.main.from).toBe(1);
    expect(editorView(textarea).state.selection.main.to).toBe(4);
    expect(editorView(textarea).state.selection.main.anchor).toBe(4);
  });

  it("keeps raw caret mapping across external replacement and host undo/redo", async () => {
    useEditors.setState({
      entries: {
        editor: {
          ...entry,
          content: "a\r\nb\r\nc\r\ndefgh",
          baseline: "a\r\nb\r\nc\r\ndefgh",
          documentId: "document",
          version: 0,
        },
      },
    });
    render(<EditorPage tabId="editor" active />);
    const textarea = await editorBox();
    replaceEditorDocument(editorDocument("editor")!, "xx\r\nyy\r\nzz\r\nnew\r\nabcdef");
    await waitFor(() =>
      expect(useEditors.getState().entries.editor?.content).toBe("xx\r\nyy\r\nzz\r\nnew\r\nabcdef"),
    );
    const view = editorView(textarea);
    await waitFor(() => expect(view.state.doc.length).toBe(19));
    view.dispatch({ selection: { anchor: 19 } });
    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(useEditors.getState().entries.editor?.content).toBe("a\r\nb\r\nc\r\ndefgh"),
    );
    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(useEditors.getState().entries.editor?.content).toBe("xx\r\nyy\r\nzz\r\nnew\r\nabcdef"),
    );
    expect(editorView(textarea).state.selection.main.from).toBe(19);
  });

  it("treats a long IME composition as one host undo transaction", async () => {
    const textarea = await prepareHistory();
    const view = editorView(textarea);
    view.focus();
    view.dispatch({ selection: { anchor: 3 } });
    fireEvent.compositionStart(textarea);
    view.dispatch({ changes: { from: 3, to: 3, insert: "拼" }, selection: { anchor: 4 } });
    view.dispatch({ changes: { from: 4, to: 4, insert: "音" }, selection: { anchor: 5 } });
    fireEvent.compositionEnd(textarea);
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("abc拼音def"));

    fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
    await waitFor(() => expect(useEditors.getState().entries.editor?.content).toBe("abcdef"));
  });
});

describe("EditorPage native scrolling and preferences", () => {
  it("uses a native CM scroller and preserves selection/viewport", async () => {
    const { container } = render(<EditorPage tabId="editor" active />);
    const textarea = await editorBox();
    expect(container.querySelector(".td-text-scrollbar")).toBeNull();
    expect(textarea.closest(".cm-scroller")).not.toBeNull();
    const view = editorView(textarea);
    view.dispatch({ selection: { anchor: 5, head: 2 } });
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(5);
  });

  it("updates CM tab width, wrapping and spellcheck without changing the draft", async () => {
    render(<EditorPage tabId="editor" active />);
    const textarea = await editorBox();
    const view = editorView(textarea);
    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.state.tabSize).toBe(4);
    expect(textarea.getAttribute("spellcheck")).toBe("false");
    act(() =>
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          editorWordWrap: true,
          editorTabSize: 8,
          editorSpellCheck: true,
        },
      }),
    );
    expect(view.state.tabSize).toBe(8);
    expect(textarea.getAttribute("spellcheck")).toBe("true");
    expect(useEditors.getState().entries.editor?.content).toBe(entry.content);
  });
});
