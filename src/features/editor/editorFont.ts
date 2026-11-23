import { StateEffect } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { reportError } from "@/lib/diagnostics";
import { AUTO_CJK_SOURCE, FONT_READY_EVENT, fontGeneration } from "@/lib/fonts/runtime";

const FAMILY = "Tunnelde Editor CJK";
const UNICODE_RANGE =
  "U+2E80-9FFF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FE4F,U+FF01-FF60,U+FFE0-FFE6,U+20000-323AF";
type AdjustableFontFace = FontFace & { sizeAdjust: string };
let face: AdjustableFontFace | undefined;
let source = "";
let generation = -1;
let usingFallback = false;
let nativeAdjustment: boolean | undefined;
const revisions = new WeakMap<EditorView, number>();
const legacyScaling = StateEffect.define<boolean>();

// Safari 15 has FontFace but lacks size-adjust. Scale only visible CJK runs
// there; Latin text, the document, and the editor's base metrics stay intact.
const matcher = new MatchDecorator({
  regexp:
    /[\u2E80-\u9FFF\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{20000}-\u{323AF}]+/gu,
  decoration: Decoration.mark({ class: "cm-cjk-glyph" }),
});
export const editorCjkScaling = [
  ViewPlugin.fromClass(
    class {
      constructor(private view: EditorView) {}
      private compositionTimer: ReturnType<typeof setTimeout> | undefined;
      finishComposition() {
        if (!this.enabled) return;
        clearTimeout(this.compositionTimer);
        this.compositionTimer = setTimeout(() => {
          if (this.view.compositionStarted) this.finishComposition();
          else {
            this.suspended = true;
            this.view.dispatch({ effects: legacyScaling.of(true) });
          }
        }, 30);
      }
      destroy() {
        clearTimeout(this.compositionTimer);
      }
      enabled = false;
      suspended = false;
      decorations = Decoration.none;
      update(update: ViewUpdate) {
        const previous = this.enabled;
        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            if (effect.is(legacyScaling)) this.enabled = effect.value;
          }
        }
        if (!this.enabled) {
          this.decorations = Decoration.none;
          return;
        }
        if (update.view.compositionStarted) {
          this.suspended = true;
          this.decorations = this.decorations.map(update.changes);
          return;
        }
        if (!previous || this.suspended) {
          this.suspended = false;
          this.decorations = matcher.createDeco(update.view);
        } else {
          this.decorations = matcher.updateDeco(update, this.decorations);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        compositionend() {
          this.finishComposition();
        },
      },
    },
  ),
  EditorView.baseTheme({
    ".cm-cjk-glyph": {
      fontSize: "calc(var(--td-mono-size) * var(--td-editor-cjk-scale, 1))",
      lineHeight: "0",
    },
  }),
];

async function alignCjkFont(view: EditorView): Promise<void> {
  if (!document.fonts?.add || typeof FontFace === "undefined") return;
  const current = (revisions.get(view) ?? 0) + 1;
  revisions.set(view, current);
  const connected = () => revisions.get(view) === current && view.dom.isConnected;
  const style = getComputedStyle(view.contentDOM);
  const font = `${style.fontStyle} ${style.fontWeight} 100px ${style.fontFamily}`;
  await document.fonts.load(font, "00000000");
  if (!connected()) return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  context.font = font;
  const target = (2 * context.measureText("00000000").width) / 8;
  if (!Number.isFinite(target) || target <= 0) return;
  if (nativeAdjustment === undefined) nativeAdjustment = "sizeAdjust" in FontFace.prototype;
  const nextSource =
    getComputedStyle(document.documentElement).getPropertyValue("--td-editor-cjk-source").trim() ||
    AUTO_CJK_SOURCE;
  if (source !== nextSource || generation !== fontGeneration()) {
    if (face) document.fonts.delete(face);
    face = undefined;
    source = nextSource;
    generation = fontGeneration();
    usingFallback = false;
  }
  if (!face) {
    const descriptors: FontFaceDescriptors & { sizeAdjust?: string } = {
      unicodeRange: UNICODE_RANGE,
    };
    if (nativeAdjustment) descriptors.sizeAdjust = "100%";
    face = new FontFace(FAMILY, nextSource, descriptors) as AdjustableFontFace;
    document.fonts.add(face);
  }
  let loading = face;
  let available = true;
  try {
    await loading.load();
  } catch (error) {
    available = false;
    if (face !== loading || !connected()) return;
    document.fonts.delete(loading);
    if (source !== AUTO_CJK_SOURCE && !usingFallback) {
      reportError("fonts", "loadEditorCjk", error, "warn");
      usingFallback = true;
      // Keep the requested choice in preferences, but use the automatic local
      // fallback while its file/family is unavailable on this machine.
      loading = new FontFace(FAMILY, AUTO_CJK_SOURCE, {
        unicodeRange: UNICODE_RANGE,
      }) as AdjustableFontFace;
      face = loading;
      document.fonts.add(loading);
      try {
        await loading.load();
        available = true;
      } catch {
        document.fonts.delete(loading);
      }
    }
    if (!available) {
      // Retain the failed face so loadingdone cannot trigger a retry loop.
      // A new preference/resource generation retries it explicitly.
      if (!connected()) return;
      view.dom.style.setProperty("--td-editor-cjk-scale", "1");
      view.dispatch({ effects: legacyScaling.of(false) });
      view.requestMeasure();
      return;
    }
  }
  if (face !== loading) return;
  if (!connected()) return;
  // Installed and imported fonts do not necessarily use a one-em CJK advance.
  // Measure their actual glyphs before applying either scaling mechanism.
  if (nativeAdjustment) face.sizeAdjust = "100%";
  context.font = `100px "${FAMILY}"`;
  const width = context.measureText("中").width;
  if (!Number.isFinite(width) || width <= 0) return;
  const scale = target / width;
  if (nativeAdjustment) face.sizeAdjust = `${scale * 100}%`;
  // Check actual glyph metrics as well as the property: ignored descriptors
  // must not make a supported older engine silently use the wrong grid.
  if (nativeAdjustment) {
    context.font = `100px "${FAMILY}"`;
    if (Math.abs(context.measureText("中").width - target) > 0.1) {
      nativeAdjustment = false;
      face.sizeAdjust = "100%";
    }
  }
  const legacy = !nativeAdjustment;
  view.dom.style.setProperty("--td-editor-cjk-scale", String(legacy ? scale : 1));
  view.dispatch({ effects: legacyScaling.of(legacy) });
  view.requestMeasure();
}

export function observeEditorFont(view: EditorView): () => void {
  let disposed = false;
  let queued = false;
  const update = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      void alignCjkFont(view).catch((error) => {
        if (!disposed) {
          reportError("fonts", "measureEditorCjk", error, "warn");
          view.requestMeasure();
        }
      });
    });
  };
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  document.fonts?.addEventListener?.("loadingdone", update);
  window.addEventListener(FONT_READY_EVENT, update);
  update();
  return () => {
    disposed = true;
    revisions.delete(view);
    observer.disconnect();
    document.fonts?.removeEventListener?.("loadingdone", update);
    window.removeEventListener(FONT_READY_EVENT, update);
  };
}
