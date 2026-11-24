import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CodeEditorSurface, editorSelectionSnapshot } from "@/features/editor/CodeEditorSurface";
import {
  editorTextMap,
  editorToSource,
  sourceToEditor,
  locationOffset,
} from "@/features/editor/editorText";
import { usePanelViewController } from "@/lib/panels/viewState";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import type { PreviewFile } from "@/store/filePreview";
import type { EditorSelectionSnapshot } from "@/store/editors";
import { usePreviewSyntax, type PreviewSyntaxSource } from "./usePreviewSyntax";
import "@/features/editor/syntax/editorSyntax.css";

const noop = () => {};
const noHistory = () => false;
function isSelection(value: unknown): value is EditorSelectionSnapshot {
  const item = value as EditorSelectionSnapshot | null;
  return (
    !!item &&
    Number.isSafeInteger(item.start) &&
    item.start >= 0 &&
    Number.isSafeInteger(item.end) &&
    item.end >= item.start &&
    ["forward", "backward", "none"].includes(item.direction) &&
    [item.scrollTop, item.scrollLeft].every(
      (offset) => offset === undefined || (Number.isFinite(offset) && offset >= 0),
    )
  );
}

export function CodePreview({
  file,
  content,
  syntax,
  active,
}: {
  file: PreviewFile;
  content: string;
  syntax?: PreviewSyntaxSource;
  active: boolean;
}) {
  const { t } = useTranslation();
  const controller = usePanelViewController();
  const view = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  const document = useMemo(
    () => ({
      tabId: `preview:${crypto.randomUUID()}`,
      documentId: crypto.randomUUID(),
      version: 0,
      path: file.path,
      name: file.path.split(/[\\/]/).pop() ?? file.path,
      content,
      dirty: false,
    }),
    [content, file.path],
  );
  const highlighted = usePreviewSyntax(document, syntax, active);
  const map = useMemo(() => editorTextMap(content), [content]);
  const [restored] = useState(() => controller?.read("text.selection", isSelection));
  const onViewReady = useCallback(() => {
    const instance = view.current;
    if (!instance) return;
    instance.scrollDOM.setAttribute("data-panel-scroll", "preview.text");
    instance.contentDOM.setAttribute("data-panel-focus", "preview.text");
    instance.contentDOM.setAttribute("aria-readonly", "true");
    instance.contentDOM.tabIndex = 0;
    setReady(true);
  }, []);
  usePanelReadiness("preview.code", ready);
  useLayoutEffect(() => {
    const instance = view.current;
    if (!ready || !instance) return;
    const position = locationOffset(content, file.line, file.column);
    const start = sourceToEditor(map, restored?.start ?? position);
    const end = sourceToEditor(map, restored?.end ?? position);
    instance.dispatch({
      selection: EditorSelection.single(
        restored?.direction === "backward" ? end : start,
        restored?.direction === "backward" ? start : end,
      ),
      effects: restored ? [] : EditorView.scrollIntoView(start, { y: "center" }),
    });
    if (restored?.scrollTop !== undefined) instance.scrollDOM.scrollTop = restored.scrollTop;
    if (restored?.scrollLeft !== undefined) instance.scrollDOM.scrollLeft = restored.scrollLeft;
    if (!instance.dom.closest("[inert]")) instance.focus();
  }, [ready, content, map, file.line, file.column, restored]);
  useLayoutEffect(
    () =>
      controller?.register("text.selection", () => {
        const instance = view.current;
        if (!instance) throw new Error("panel.viewState.notReady");
        const selection = editorSelectionSnapshot(instance.state, instance);
        return {
          ...selection,
          start: editorToSource(map, selection.start),
          end: editorToSource(map, selection.end),
        };
      }),
    [controller, map],
  );
  return (
    <div className="file-preview__text file-preview__code">
      <CodeEditorSurface
        content={content}
        documentId={document.documentId}
        version={document.version}
        label={t("sftp.preview")}
        readOnly
        wordWrap={false}
        tabSize={4}
        spellCheck={false}
        viewRef={view}
        onViewReady={onViewReady}
        onChange={noop}
        onSelection={noop}
        onUndo={noHistory}
        onRedo={noHistory}
        onSelectionChanged={controller?.changed}
        tokens={highlighted.tokens}
        tokensDocumentId={document.documentId}
        tokensVersion={document.version}
        onVisibleRangeSettled={highlighted.onVisibleRangeSettled}
      />
    </div>
  );
}
