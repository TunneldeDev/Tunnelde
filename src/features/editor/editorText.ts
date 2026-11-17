interface LineBreak {
  /** Offset of the normalized newline in the CM document. */
  editor: number;
  /** First source offset of the separator. */
  source: number;
  /** One past the separator in the source. */
  sourceEnd: number;
  /** Exact source separator. */
  text: "\n" | "\r" | "\r\n";
}

export interface EditorTextMap {
  source: string;
  normalized: string;
  breaks: readonly LineBreak[];
  dominant: "\n" | "\r" | "\r\n";
  identity: boolean;
}

/** Sparse CR/CRLF index. Pure LF documents stay zero-copy with no index. */
export function editorTextMap(source: string): EditorTextMap {
  if (!source.includes("\r"))
    return { source, normalized: source, breaks: [], dominant: "\n", identity: true };
  const breaks: LineBreak[] = [];
  let editor = 0;
  const counts = { lf: 0, cr: 0, crlf: 0 };
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 10) {
      breaks.push({ editor, source: index, sourceEnd: index + 1, text: "\n" });
      counts.lf += 1;
      editor += 1;
    } else if (code === 13) {
      if (source.charCodeAt(index + 1) === 10) {
        breaks.push({ editor, source: index, sourceEnd: index + 2, text: "\r\n" });
        counts.crlf += 1;
        index += 1;
      } else {
        breaks.push({ editor, source: index, sourceEnd: index + 1, text: "\r" });
        counts.cr += 1;
      }
      editor += 1;
    } else {
      editor += 1;
    }
  }
  const dominant =
    counts.crlf >= counts.cr && counts.crlf >= counts.lf
      ? "\r\n"
      : counts.cr > counts.lf
        ? "\r"
        : "\n";
  return {
    source,
    normalized: source.replace(/\r\n?/g, "\n"),
    breaks,
    dominant,
    identity: false,
  };
}

function priorBreak(breaks: readonly LineBreak[], editorOffset: number) {
  let low = 0;
  let high = breaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (breaks[middle]!.editor <= editorOffset) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function editorToSource(map: EditorTextMap, editorOffset: number): number {
  const offset = Math.max(0, Math.min(map.normalized.length, editorOffset));
  if (map.identity) return offset;
  const index = priorBreak(map.breaks, offset);
  if (index < 0) return offset;
  const line = map.breaks[index]!;
  const extra = line.sourceEnd - line.source - 1;
  return offset <= line.editor
    ? offset + line.source - line.editor
    : offset + line.source - line.editor + extra;
}

export function sourceToEditor(map: EditorTextMap, sourceOffset: number): number {
  const offset = Math.max(0, Math.min(map.source.length, sourceOffset));
  if (map.identity) return offset;
  let low = 0;
  let high = map.breaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (map.breaks[middle]!.source < offset) low = middle + 1;
    else high = middle;
  }
  const index = low - 1;
  if (index < 0) return offset;
  const line = map.breaks[index]!;
  if (offset < line.sourceEnd) return line.editor;
  return line.editor + (offset - line.sourceEnd) + 1;
}

export function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 13 && source.charCodeAt(index + 1) === 10) {
      starts.push(index + 2);
      index += 1;
    } else if (code === 10 || code === 13) starts.push(index + 1);
  }
  return starts;
}

export function locationOffset(content: string, lineNumber: number, column: number): number {
  const starts = sourceLineStarts(content);
  let offset = starts[Math.max(0, Math.min(starts.length - 1, lineNumber - 1))] ?? 0;
  let remaining = Math.max(0, column - 1);
  while (offset < content.length && remaining > 0) {
    const code = content.charCodeAt(offset);
    if (code === 10 || code === 13) break;
    const size =
      code >= 0xd800 &&
      code <= 0xdbff &&
      content.charCodeAt(offset + 1) >= 0xdc00 &&
      content.charCodeAt(offset + 1) <= 0xdfff
        ? 2
        : 1;
    offset += size;
    remaining -= 1;
  }
  return offset;
}
