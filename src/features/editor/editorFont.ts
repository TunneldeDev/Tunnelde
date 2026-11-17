import type { EditorView } from "@codemirror/view";
import cjkFontUrl from "../../../assets/fonts/noto-cjk-editor.woff2?url";

const FAMILY = "Tunnelde Editor CJK";
// The runtime supports this CSS Fonts descriptor before TypeScript's DOM types.
type AdjustableFontFace = FontFace & { sizeAdjust: string };
let face: AdjustableFontFace | undefined;
let revision = 0;

/** The bundled Han/kana/fullwidth glyphs have a 1em advance. Match two Latin cells. */
async function alignCjkFont(view: EditorView): Promise<void> {
  if (!document.fonts?.add || typeof FontFace === "undefined") return;
  const current = ++revision;
  const style = getComputedStyle(view.contentDOM);
  const font = `${style.fontStyle} ${style.fontWeight} 100px ${style.fontFamily}`;
  // Measuring before a user's chosen Latin face has loaded would calibrate to
  // the system fallback, then leave CJK misaligned when the real face arrives.
  await document.fonts.load(font, "00000000");
  if (current !== revision || !view.dom.isConnected) return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  context.font = font;
  const scale = (2 * context.measureText("00000000").width) / 8;
  if (!Number.isFinite(scale) || scale <= 0) return;
  if (!face) {
    const descriptors: FontFaceDescriptors & { sizeAdjust: string } = {
      unicodeRange:
        "U+2E80-9FFF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FE4F,U+FF01-FF60,U+FFE0-FFE6,U+20000-323AF",
      sizeAdjust: `${scale}%`,
    };
    face = new FontFace(FAMILY, `url("${cjkFontUrl}")`, descriptors) as AdjustableFontFace;
    document.fonts.add(face);
  } else {
    face.sizeAdjust = `${scale}%`;
  }
  await face.load();
  if (view.dom.isConnected) view.requestMeasure();
}

/** Font changes must also invalidate CodeMirror's caret and selection metrics. */
export function observeEditorFont(view: EditorView): () => void {
  let disposed = false;
  let queued = false;
  const update = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      void alignCjkFont(view).catch(() => {
        // Keep the editable system fallback if local font decoding fails.
        if (!disposed) view.requestMeasure();
      });
    });
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  document.fonts?.addEventListener?.("loadingdone", update);
  update();
  return () => {
    disposed = true;
    observer.disconnect();
    document.fonts?.removeEventListener?.("loadingdone", update);
  };
}
