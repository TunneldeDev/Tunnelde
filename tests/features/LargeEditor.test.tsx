import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LargeEditor, editorSelectionSnapshot } from "@/features/editor/LargeEditor";
import { editorTextMap, editorToSource, sourceToEditor } from "@/features/editor/editorText";
import { locationOffset } from "@/features/editor/largeEditorState";
import type { EditorSelectionSnapshot } from "@/store/editors";

function mount(content: string) {
  const result: {
    view: { current: EditorView | null };
    changes: Array<[string, EditorSelectionSnapshot]>;
    undo: ReturnType<typeof vi.fn>;
    redo: ReturnType<typeof vi.fn>;
    rerender: (props: Partial<Parameters<typeof LargeEditor>[0]>) => void;
  } = {
    view: { current: null },
    changes: [],
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    rerender: () => undefined,
  };
  function Harness(props: Partial<Parameters<typeof LargeEditor>[0]>) {
    const view = useRef<EditorView | null>(null);
    result.view = view;
    return (
      <LargeEditor
        content={content}
        documentId="document"
        version={0}
        label="bridge.js"
        wordWrap={false}
        tabSize={4}
        spellCheck={false}
        viewRef={view}
        onChange={(next, selection) => result.changes.push([next, selection])}
        onSelection={() => undefined}
        onUndo={result.undo}
        onRedo={result.redo}
        {...props}
      />
    );
  }
  const rendered = render(<Harness />);
  result.rerender = (props) => rendered.rerender(<Harness {...props} />);
  return result;
}

afterEach(cleanup);

describe("LargeEditor", () => {
  it("mounts an accessible virtualized textbox and preserves CRLF through edits", async () => {
    const editor = mount("one\r\ntwo\r\nthree");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    expect(view.contentDOM.getAttribute("role")).toBe("textbox");
    expect(view.contentDOM.getAttribute("aria-label")).toBe("bridge.js");
    view.dispatch({ changes: { from: 0, to: 0, insert: "零" } });
    expect(view.state.doc.toString()).toBe("零one\ntwo\nthree");
    expect(editor.changes.at(-1)?.[0]).toBe("零one\r\ntwo\r\nthree");
  });

  it("keeps exact UTF-16 selections and surrogate boundaries across external replacement", async () => {
    const editor = mount("A😀中文\r\nZ");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    view.dispatch({ selection: EditorSelection.single(3, 1) });
    expect(editorSelectionSnapshot(view.state, view)).toMatchObject({
      start: 1,
      end: 3,
      direction: "backward",
    });
    act(() => editor.rerender({ content: "😀B", version: 1 }));
    expect(view.state.doc.toString()).toBe("😀B");
    expect(view.state.selection.main.from).toBeLessThanOrEqual(view.state.doc.length);
  });

  it("routes undo and redo to the host without creating a local history stack", async () => {
    const editor = mount("abcdef");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    view.dispatch({ changes: { from: 3, to: 3, insert: "X" } });
    expect(view.state.doc.toString()).toBe("abcXdef");
    expect(editor.undo).not.toHaveBeenCalled();
    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true });
    view.contentDOM.dispatchEvent(event);
    await waitFor(() => expect(editor.undo).toHaveBeenCalledTimes(1));
    const before = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(before);
    await waitFor(() => expect(editor.undo).toHaveBeenCalledTimes(2));
  });

  it("clamps and applies an explicit host selection restore", async () => {
    const editor = mount("abcdef");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    act(() =>
      editor.rerender({
        restoreSelection: { start: 2, end: 4, direction: "backward", scrollTop: 9 },
        restoreToken: 1,
      }),
    );
    expect(view.state.selection.main.anchor).toBe(4);
    expect(view.state.selection.main.head).toBe(2);
  });

  it("maps CRLF and surrogate-aware locations without splitting emoji", () => {
    expect(locationOffset("a\r\nb😀c", 2, 2)).toBe(4);
    expect(locationOffset("a\r\nb😀c", 1, 2)).toBe(1);
    expect(locationOffset("a\n😀c", 2, 2)).toBe(4);
  });

  it("reconfigures wrap and editability without replacing the view", async () => {
    const editor = mount("abcdef");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    act(() => editor.rerender({ wordWrap: true, readOnly: true, tabSize: 8 }));
    expect(editor.view.current).toBe(view);
    expect(view.state.doc.toString()).toBe("abcdef");
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(view.contentDOM.style.tabSize).toBe("8");
  });

  it("maps exact CRLF and bare-CR boundaries with a sparse index", () => {
    const crlf = editorTextMap("a\r\nb");
    expect(crlf.normalized).toBe("a\nb");
    expect([0, 1, 2, 3].map((offset) => editorToSource(crlf, offset))).toEqual([0, 1, 3, 4]);
    expect([0, 1, 2, 3, 4].map((offset) => sourceToEditor(crlf, offset))).toEqual([0, 1, 1, 2, 3]);
    const mixed = editorTextMap("a\r\nb\nc\rd");
    expect(mixed.normalized).toBe("a\nb\nc\nd");
    expect(mixed.breaks.map((line) => line.text)).toEqual(["\r\n", "\n", "\r"]);
    expect(editorToSource(mixed, 2)).toBe(3);
    expect(editorToSource(mixed, 4)).toBe(5);
    expect(sourceToEditor(mixed, 3)).toBe(2);
  });

  it("uses a zero-copy identity map for pure LF and line-only sources", () => {
    const source = "one\ntwo\nthree";
    const map = editorTextMap(source);
    expect(map.identity).toBe(true);
    expect(map.breaks.length).toBe(0);
    expect(editorToSource(map, 7)).toBe(7);
    expect(sourceToEditor(map, 7)).toBe(7);
  });

  it("keeps CM lines free of CR while source remains exact", async () => {
    const source = "one\ntwo\r\nthree\rfour";
    const editor = mount(source);
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    expect(view.state.doc.lines).toBe(4);
    for (let line = 1; line <= view.state.doc.lines; line += 1)
      expect(view.state.doc.line(line).text).not.toContain("\r");
    expect(editorTextMap(source).source).toBe(source);
  });

  it("rebuilds raw source for multi-range transactions without corrupting earlier edits", async () => {
    const editor = mount("one\r\ntwo\r\nthree\r\nfour");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    view.dispatch({
      changes: [
        { from: 0, to: 3, insert: "ONE" },
        { from: 8, to: 13, insert: "THREE" },
      ],
    });
    expect(editor.changes.at(-1)?.[0]).toBe("ONE\r\ntwo\r\nTHREE\r\nfour");
  });

  it("uses line numbers and configures tab size and indentation in editor state", async () => {
    const editor = mount("a\nb");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.state.tabSize).toBe(4);
    act(() => editor.rerender({ tabSize: 8 }));
    expect(view.state.tabSize).toBe(8);
  });

  it("does not reapply an old restore after later typing", async () => {
    const editor = mount("abcdef");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    act(() =>
      editor.rerender({
        restoreSelection: { start: 3, end: 3, direction: "none" },
        restoreToken: 1,
      }),
    );
    expect(view.state.selection.main.from).toBe(3);
    act(() =>
      editor.rerender({
        content: "abcXdef",
        version: 1,
        restoreSelection: null,
        restoreToken: 1,
      }),
    );
    act(() => view.dispatch({ selection: { anchor: 4 } }));
    act(() =>
      view.dispatch({ changes: { from: 4, to: 4, insert: "y" }, selection: { anchor: 5 } }),
    );
    await waitFor(() => expect(editor.view.current!.state.selection.main.from).toBe(5));
  });

  it("inserts the dominant CRLF ending on Enter and indents by configured tab size", async () => {
    const editor = mount("a\r\nb");
    await waitFor(() => expect(editor.view.current).not.toBeNull());
    const view = editor.view.current!;
    view.dispatch({ selection: { anchor: 1 } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(editor.changes.at(-1)?.[0]).toBe("a\r\n\r\nb"));
    act(() => editor.rerender({ content: "a\r\n\r\nb", version: 1, tabSize: 8 }));
    const current = editor.view.current!;
    current.dispatch({ selection: { anchor: 0 } });
    current.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(editor.changes.at(-1)?.[0]?.startsWith("        a")).toBe(true));
  });

  it("uses the editor line separator for initialization", () => {
    const state = EditorState.create({
      doc: Text.of(["a\r", "b"]),
      extensions: [EditorState.lineSeparator.of("\r\n")],
    });
    expect(state.doc.toString()).toBe("a\r\nb");
  });
});
