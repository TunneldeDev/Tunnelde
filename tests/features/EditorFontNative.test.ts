import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { editorCjkScaling, observeEditorFont } from "@/features/editor/editorFont";

it("measures non-em CJK advances, changes sources, and falls back after a failed native load", async () => {
  const faces: AdjustableFace[] = [];
  class AdjustableFace {
    adjustment = 100;
    constructor(
      public family: string,
      public source: string,
    ) {
      faces.push(this);
    }
    get sizeAdjust() {
      return `${this.adjustment}%`;
    }
    set sizeAdjust(value: string) {
      this.adjustment = parseFloat(value);
    }
    async load() {
      if (this.source.includes("Missing")) throw new Error("missing");
      return this;
    }
  }
  const fonts = Object.assign(new EventTarget(), {
    add: vi.fn(),
    delete: vi.fn(),
    load: vi.fn(async () => []),
  });
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  vi.stubGlobal("FontFace", AdjustableFace);
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) => ({
      width: text === "中" ? 90 * (faces.at(-1)!.adjustment / 100) : 480,
    }),
  } as unknown as CanvasRenderingContext2D);
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "中ab文",
      selection: { anchor: 3, head: 1 },
      extensions: editorCjkScaling,
    }),
  });
  const stop = observeEditorFont(view);
  try {
    await vi.waitFor(() => expect(faces[0]?.adjustment).toBeCloseTo(133.333333));
    expect(view.dom.style.getPropertyValue("--td-editor-cjk-scale")).toBe("1");
    document.documentElement.style.setProperty("--td-editor-cjk-source", 'local("Another")');
    await vi.waitFor(() => expect(faces.at(-1)?.source).toBe('local("Another")'));
    await vi.waitFor(() => expect(faces.at(-1)?.adjustment).toBeCloseTo(133.333333));
    expect(fonts.delete).toHaveBeenCalledWith(faces[0]);
    document.documentElement.style.setProperty("--td-editor-cjk-source", 'local("Missing")');
    await vi.waitFor(() =>
      expect(faces.find((face) => face.source.includes("Missing"))).toBeTruthy(),
    );
    expect(fonts.delete).toHaveBeenCalledWith(
      faces.find((face) => face.source.includes("Missing")),
    );
    await vi.waitFor(() => expect(faces.at(-1)?.adjustment).toBeCloseTo(133.333333));
    expect(view.contentDOM.querySelector(".cm-cjk-glyph")).toBeNull();
    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.state.selection.main.head).toBe(1);
    expect(view.state.doc.toString()).toBe("中ab文");
  } finally {
    stop();
    view.destroy();
    parent.remove();
    document.documentElement.style.removeProperty("--td-editor-cjk-source");
    canvas.mockRestore();
    vi.unstubAllGlobals();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
  }
});
