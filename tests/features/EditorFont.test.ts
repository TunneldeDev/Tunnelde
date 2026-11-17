import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { editorCjkScaling, observeEditorFont } from "@/features/editor/editorFont";

it("scales visible CJK runs on engines without size-adjust and preserves each view's selection", async () => {
  class LegacyFace {
    family = "Tunnelde Editor CJK";
    load() {
      return Promise.resolve(this);
    }
  }
  const fonts = Object.assign(new EventTarget(), {
    add: vi.fn(),
    load: vi.fn(async () => []),
  });
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  vi.stubGlobal("FontFace", LegacyFace);
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: () => ({ width: 480 }),
  } as unknown as CanvasRenderingContext2D);
  const views: EditorView[] = [];
  const stops: Array<() => void> = [];
  try {
    for (let index = 0; index < 2; index++) {
      const parent = document.body.appendChild(document.createElement("div"));
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: "中ab文",
          selection: { anchor: 3, head: 1 },
          extensions: editorCjkScaling,
        }),
      });
      views.push(view);
      stops.push(observeEditorFont(view));
    }
    await vi.waitFor(() => {
      for (const view of views) {
        expect(view.dom.style.getPropertyValue("--td-editor-cjk-scale")).toBe("1.2");
        expect(
          [...view.contentDOM.querySelectorAll(".cm-cjk-glyph")].map((node) => node.textContent),
        ).toEqual(["中", "文"]);
      }
    });
    for (const view of views) {
      expect(view.state.selection.main.anchor).toBe(3);
      expect(view.state.selection.main.head).toBe(1);
      view.dispatch({ changes: { from: 1, insert: "新" } });
      expect(view.state.doc.toString()).toBe("中新ab文");
      expect(
        [...view.contentDOM.querySelectorAll(".cm-cjk-glyph")].map((node) => node.textContent),
      ).toEqual(["中新", "文"]);
    }
  } finally {
    stops.forEach((stop) => stop());
    views.forEach((view) => {
      const parent = view.dom.parentElement;
      view.destroy();
      parent?.remove();
    });
    canvas.mockRestore();
    vi.unstubAllGlobals();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
  }
});
