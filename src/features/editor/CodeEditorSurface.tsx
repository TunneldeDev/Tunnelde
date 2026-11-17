import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, Text, Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import "./CodeEditorSurface.css";
import { editorCjkScaling, observeEditorFont } from "./editorFont";

import type { EditorSelectionSnapshot } from "@/store/editors";
import {
  editorTextMap,
  editorToSource,
  lineEndingAtSource,
  sourceToEditor,
  type EditorTextMap,
} from "./editorText";

export interface EditorToken {
  /** Half-open UTF-16 offsets, absolute or relative to the requested window. */
  start: number;
  end: number;
  type: string;
}

export interface EditorVisibleRange {
  from: number;
  to: number;
  documentId: string;
  version: number;
}

interface CodeEditorSurfaceProps {
  content: string;
  documentId: string;
  version: number;
  label: string;
  readOnly?: boolean;
  wordWrap: boolean;
  tabSize: number;
  spellCheck: boolean;
  tokens?: readonly EditorToken[];
  tokensDocumentId?: string;
  tokensVersion?: number;
  tokensRange?: { from: number; to: number };
  onVisibleRangeSettled?: (range: EditorVisibleRange) => void;
  onChange: (content: string, selection: EditorSelectionSnapshot) => void;
  onBeforeInput?: (inputType: string, selection: EditorSelectionSnapshot) => void;
  onSelection: (selection: EditorSelectionSnapshot) => void;
  onUndo: () => boolean;
  onRedo: () => boolean;
  onCompositionStart?: (selection: EditorSelectionSnapshot) => void;
  onCompositionEnd?: (selection: EditorSelectionSnapshot) => void;
  viewRef: MutableRefObject<EditorView | null>;
  onViewReady?: () => void;
  restoreSelection?: EditorSelectionSnapshot | null;
  restoreToken?: number;
  onSelectionSnapshot?: (selection: EditorSelectionSnapshot) => void;
  onSelectionChanged?: (selection: EditorSelectionSnapshot) => void;
}

function direction(anchor: number, head: number): "forward" | "backward" | "none" {
  if (anchor === head) return "none";
  return anchor < head ? "forward" : "backward";
}

export function editorSelectionSnapshot(
  state: EditorState,
  view: EditorView,
): EditorSelectionSnapshot {
  const range = state.selection.main;
  return {
    start: range.from,
    end: range.to,
    direction: direction(range.anchor, range.head),
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  };
}

function clampSelection(
  selection: EditorSelectionSnapshot,
  length: number,
): EditorSelectionSnapshot {
  const end = Math.max(0, Math.min(length, selection.end));
  const start = Math.max(0, Math.min(end, selection.start));
  return {
    start,
    end,
    direction: selection.direction,
    ...(selection.scrollTop === undefined ? {} : { scrollTop: selection.scrollTop }),
    ...(selection.scrollLeft === undefined ? {} : { scrollLeft: selection.scrollLeft }),
  };
}

/** Preserve exact source text, including CRLF, while CM represents lines internally. */
export function editorText(content: string): Text {
  return Text.of(editorTextMap(content).normalized.split("\n"));
}

function toEditorSelection(
  selection: EditorSelectionSnapshot,
  map: EditorTextMap,
): EditorSelectionSnapshot {
  return {
    ...selection,
    start: sourceToEditor(map, selection.start),
    end: sourceToEditor(map, selection.end),
  };
}

function toSourceSelection(
  selection: EditorSelectionSnapshot,
  map: EditorTextMap,
): EditorSelectionSnapshot {
  return {
    ...selection,
    start: editorToSource(map, selection.start),
    end: editorToSource(map, selection.end),
  };
}

function transactionInputType(transaction: Transaction): string {
  const userEvent = transaction.annotation(Transaction.userEvent) ?? "";
  if (userEvent === "input.indent" || userEvent === "indent" || userEvent === "delete.dedent")
    return "insertReplacementText";
  if (userEvent === "delete.cut") return "deleteByCut";
  if (userEvent === "delete.forward") return "deleteContentForward";
  if (userEvent === "delete.backward") return "deleteContentBackward";
  if (userEvent.startsWith("delete")) return "insertReplacementText";
  if (userEvent === "input.type" || userEvent.startsWith("input.type.")) return "insertText";
  if (userEvent === "input.paste") return "insertFromPaste";
  if (userEvent === "input.drop") return "insertFromDrop";
  let insertedNewline = false;
  transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.toString().includes("\n")) insertedNewline = true;
  });
  if (insertedNewline) return "insertParagraph";
  return "insertReplacementText";
}

const tokenDecorations = new Map<string, Decoration>();

function decorationFor(type: string) {
  let decoration = tokenDecorations.get(type);
  if (!decoration) {
    const safe = type.replace(/[^a-z0-9_-]/gi, "");
    decoration = Decoration.mark({ class: `cm-editor-token-${safe || "text"}` });
    tokenDecorations.set(type, decoration);
  }
  return decoration;
}

function tokenSet(
  tokens: readonly EditorToken[],
  map: EditorTextMap,
  range?: { from: number; to: number },
): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  for (const token of tokens) {
    if (
      token.start < 0 ||
      token.end > map.source.length ||
      token.start >= token.end ||
      (range && (token.start < range.from || token.end > range.to))
    )
      continue;
    const from = sourceToEditor(map, token.start);
    const to = sourceToEditor(map, token.end);
    if (from < 0 || to > map.normalized.length || from >= to) continue;
    ranges.push(decorationFor(token.type).range(from, to));
  }
  return Decoration.set(ranges, true);
}

export function CodeEditorSurface({
  content,
  documentId,
  version,
  label,
  readOnly = false,
  wordWrap,
  tabSize,
  spellCheck,
  tokens = [],
  tokensDocumentId,
  tokensVersion,
  tokensRange,
  onVisibleRangeSettled,
  onChange,
  onBeforeInput,
  onSelection,
  onUndo,
  onRedo,
  onCompositionStart,
  onCompositionEnd,
  viewRef,
  onViewReady,
  restoreSelection = null,
  restoreToken = 0,
  onSelectionSnapshot,
  onSelectionChanged,
}: CodeEditorSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({
    onChange,
    onBeforeInput,
    onSelection,
    onUndo,
    onRedo,
    onCompositionStart,
    onCompositionEnd,
    onViewReady,
    onSelectionSnapshot,
    onSelectionChanged,
    onVisibleRangeSettled,
  });
  const syncing = useRef(false);
  const lastRestoreToken = useRef(0);
  const visibleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestVersion = useRef(version);
  const latestContent = useRef(content);
  const latestMap = useRef(editorTextMap(content));
  const editable = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const decorations = useRef(new Compartment());
  const tab = useRef(new Compartment());
  useLayoutEffect(() => {
    latestVersion.current = version;
    callbacks.current = {
      onChange,
      onBeforeInput,
      onSelection,
      onUndo,
      onRedo,
      onCompositionStart,
      onCompositionEnd,
      onViewReady,
      onSelectionSnapshot,
      onSelectionChanged,
      onVisibleRangeSettled,
    };
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (syncing.current) return;
      const selected = toSourceSelection(
        editorSelectionSnapshot(update.state, update.view),
        latestMap.current,
      );
      if (update.docChanged) {
        const first = update.transactions[0];
        if (first) {
          callbacks.current.onBeforeInput?.(
            transactionInputType(first),
            toSourceSelection(
              editorSelectionSnapshot(first.startState, update.view),
              latestMap.current,
            ),
          );
        }
        // CM normalizes line separators internally. Reconstruct source from the
        // pre-edit source map so unchanged CRLF/CR bytes survive transactions.
        let source = latestContent.current;
        let map = latestMap.current;
        for (const transaction of update.transactions) {
          const before = source;
          const beforeMap = map;
          const pieces: string[] = [];
          let cursor = 0;
          const changes: Array<{ from: number; to: number; text: string }> = [];
          transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const from = editorToSource(beforeMap, fromA);
            const to = editorToSource(beforeMap, toA);
            const ending = lineEndingAtSource(beforeMap, from);
            changes.push({
              from,
              to,
              text: inserted.toString().replace(/\n/g, ending),
            });
          });
          for (const change of changes) {
            pieces.push(before.slice(cursor, change.from), change.text);
            cursor = change.to;
          }
          pieces.push(before.slice(cursor));
          source = pieces.join("");
          map = editorTextMap(source);
        }
        latestContent.current = source;
        latestMap.current = map;
        const sourceSelection = toSourceSelection(
          editorSelectionSnapshot(update.state, update.view),
          map,
        );
        callbacks.current.onChange(source, sourceSelection);
      } else if (update.selectionSet) {
        callbacks.current.onSelection(selected);
        callbacks.current.onSelectionChanged?.(selected);
      }
      if (update.viewportChanged) {
        if (visibleTimer.current) clearTimeout(visibleTimer.current);
        visibleTimer.current = setTimeout(() => {
          const range = update.view.visibleRanges[0];
          if (range)
            callbacks.current.onVisibleRangeSettled?.({
              from: editorToSource(latestMap.current, range.from),
              to: editorToSource(latestMap.current, range.to),
              documentId,
              version: latestVersion.current,
            });
        }, 120);
      }
    });
    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: editorText(content),
        extensions: [
          lineNumbers(),
          editorCjkScaling,
          highlightSpecialChars(),
          tab.current.of([EditorState.tabSize.of(tabSize), indentUnit.of(" ".repeat(tabSize))]),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          drawSelection(),
          search({ top: true }),
          keymap.of([
            { key: "Mod-z", run: () => callbacks.current.onUndo() },
            { key: "Mod-Shift-z", run: () => callbacks.current.onRedo() },
            { key: "Mod-y", run: () => callbacks.current.onRedo() },
            {
              key: "Tab",
              run: (view) => {
                if (view.state.selection.main.empty) {
                  view.dispatch({
                    ...view.state.replaceSelection(" ".repeat(view.state.tabSize)),
                    userEvent: "input.indent",
                  });
                  return true;
                }
                return false;
              },
            },
            {
              key: "Escape",
              run: () => false,
            },
            ...closeBracketsKeymap,
            ...searchKeymap,
            indentWithTab,
            ...defaultKeymap.filter(
              (binding) =>
                !["Mod-z", "Mod-Shift-z", "Mod-y"].includes(binding.key ?? "") &&
                !String(binding.run?.name ?? "")
                  .toLowerCase()
                  .includes("undo"),
            ),
          ]),
          editable.current.of(EditorView.editable.of(!readOnly)),
          wrapping.current.of(wordWrap ? EditorView.lineWrapping : []),
          decorations.current.of(
            EditorView.decorations.of(tokenSet(tokens, latestMap.current, tokensRange)),
          ),
          EditorView.theme({
            "&": {
              height: "100%",
              fontFamily: '"Tunnelde Editor CJK", var(--td-mono)',
              fontSize: "var(--td-mono-size)",
            },
            ".cm-scroller": {
              fontFamily: "inherit",
              lineHeight: "1.55",
              overflow: "auto",
              scrollbarWidth: "thin",
              textRendering: "optimizeSpeed",
              fontVariantLigatures: "none",
              fontKerning: "none",
            },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: "var(--td-text)",
            },
            ".cm-selectionBackground": { backgroundColor: "var(--td-accent-soft)" },
            ".cm-searchMatch": { backgroundColor: "var(--td-accent-soft)" },
            ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--td-accent)" },
            ".cm-matchingBracket": {
              backgroundColor: "var(--td-accent-soft)",
              outline: "1px solid var(--td-accent)",
            },
            ".cm-panels": {
              background: "var(--td-panel)",
              color: "var(--td-text)",
              borderColor: "var(--td-border)",
            },
            ".cm-content": { padding: "10px 0", tabSize: String(tabSize) },
            ".cm-gutters": {
              display: "flex",
              background: "var(--td-bg)",
              color: "var(--td-faint)",
              border: "none",
            },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px" },
            ".cm-line": { padding: "0 12px 0 0" },
            "&.cm-focused": { outline: "none" },
            ".cm-selectionBackground, ::selection": { backgroundColor: "var(--td-accent-soft)" },
          }),
          EditorView.domEventHandlers({
            beforeinput: (event, view) => {
              if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
                event.preventDefault();
                const selected = toSourceSelection(
                  editorSelectionSnapshot(view.state, view),
                  latestMap.current,
                );
                callbacks.current.onSelection(selected);
                if (event.inputType === "historyUndo") callbacks.current.onUndo();
                else callbacks.current.onRedo();
                return true;
              }
              const selected = toSourceSelection(
                editorSelectionSnapshot(view.state, view),
                latestMap.current,
              );
              callbacks.current.onBeforeInput?.(event.inputType, selected);
              return false;
            },
            compositionstart: (_event, view) => {
              callbacks.current.onCompositionStart?.(
                toSourceSelection(editorSelectionSnapshot(view.state, view), latestMap.current),
              );
              return false;
            },
            compositionend: (_event, view) => {
              callbacks.current.onCompositionEnd?.(
                toSourceSelection(editorSelectionSnapshot(view.state, view), latestMap.current),
              );
              return false;
            },
          }),
          updateListener,
        ],
      }),
    });
    viewRef.current = instance;
    const stopObservingFont = observeEditorFont(instance);
    instance.contentDOM.spellcheck = spellCheck;
    instance.contentDOM.setAttribute("autocorrect", "off");
    instance.contentDOM.setAttribute("autocapitalize", "off");
    instance.contentDOM.setAttribute("aria-label", label);
    instance.contentDOM.setAttribute("role", "textbox");
    instance.contentDOM.setAttribute("aria-multiline", "true");
    callbacks.current.onViewReady?.();
    let scrollFrame = 0;
    const onScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        callbacks.current.onSelectionChanged?.(
          toSourceSelection(editorSelectionSnapshot(instance.state, instance), latestMap.current),
        );
      });
    };
    instance.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopObservingFont();
      instance.scrollDOM.removeEventListener("scroll", onScroll);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      if (visibleTimer.current) clearTimeout(visibleTimer.current);
      instance.destroy();
      if (viewRef.current === instance) viewRef.current = null;
    };
    // The view belongs to one document identity; external text is synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, viewRef]);

  useLayoutEffect(() => {
    if (!syncing.current) {
      latestContent.current = content;
      latestMap.current = editorTextMap(content);
    }
  }, [content]);

  useLayoutEffect(() => {
    const instance = viewRef.current;
    const map = editorTextMap(content);
    if (!instance || instance.state.doc.toString() === map.normalized) return;
    syncing.current = true;
    try {
      const current = toSourceSelection(
        editorSelectionSnapshot(instance.state, instance),
        latestMap.current,
      );
      const selection = toEditorSelection(clampSelection(current, content.length), map);
      instance.dispatch({
        changes: { from: 0, to: instance.state.doc.length, insert: editorText(content) },
        selection: EditorSelection.single(selection.start, selection.end),
        scrollIntoView: false,
      });
      latestContent.current = content;
      latestMap.current = map;
    } finally {
      syncing.current = false;
    }
  }, [content, documentId, version, viewRef]);

  useLayoutEffect(() => {
    const instance = viewRef.current;
    if (!instance) return;
    instance.dispatch({
      effects: [
        editable.current.reconfigure(EditorView.editable.of(!readOnly)),
        wrapping.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
        tab.current.reconfigure([
          EditorState.tabSize.of(tabSize),
          indentUnit.of(" ".repeat(tabSize)),
        ]),
      ],
    });
    instance.contentDOM.spellcheck = spellCheck;
    if (spellCheck) instance.contentDOM.setAttribute("spellcheck", "true");
    else instance.contentDOM.setAttribute("spellcheck", "false");
    instance.contentDOM.style.tabSize = String(tabSize);
    instance.contentDOM.setAttribute("aria-label", label);
  }, [label, readOnly, spellCheck, tabSize, wordWrap, viewRef]);

  useEffect(() => {
    const instance = viewRef.current;
    if (!instance) return;
    const range = instance.visibleRanges[0] ?? {
      from: 0,
      to: Math.min(instance.state.doc.length, 2000),
    };
    callbacks.current.onVisibleRangeSettled?.({
      from: editorToSource(latestMap.current, range.from),
      to: editorToSource(latestMap.current, range.to),
      documentId,
      version,
    });
  }, [documentId, version, viewRef]);

  useLayoutEffect(() => {
    const instance = viewRef.current;
    if (!restoreSelection) {
      lastRestoreToken.current = 0;
      return;
    }
    if (!instance || restoreToken === lastRestoreToken.current) return;
    lastRestoreToken.current = restoreToken;
    const selection = toEditorSelection(
      clampSelection(restoreSelection, content.length),
      editorTextMap(content),
    );
    const anchor = selection.direction === "backward" ? selection.end : selection.start;
    const head = selection.direction === "backward" ? selection.start : selection.end;
    instance.dispatch({ selection: EditorSelection.single(anchor, head) });
    if (selection.scrollTop !== undefined) instance.scrollDOM.scrollTop = selection.scrollTop;
    if (selection.scrollLeft !== undefined) instance.scrollDOM.scrollLeft = selection.scrollLeft;
    callbacks.current.onSelectionSnapshot?.(
      toSourceSelection(editorSelectionSnapshot(instance.state, instance), latestMap.current),
    );
  }, [content, restoreSelection, restoreToken, viewRef]);

  useLayoutEffect(() => {
    const instance = viewRef.current;
    if (!instance) return;
    const snapshot =
      tokensDocumentId === documentId && tokensVersion === version
        ? tokenSet(tokens, latestMap.current, tokensRange)
        : Decoration.none;
    instance.dispatch({
      effects: decorations.current.reconfigure(EditorView.decorations.of(snapshot)),
    });
  }, [documentId, tokens, tokensDocumentId, tokensRange, tokensVersion, version, viewRef]);

  return <div ref={host} className="editor-large" />;
}
