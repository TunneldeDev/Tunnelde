export type FontReference =
  { source: "system"; family: string } | { source: "imported"; id: string };

export interface FontSelections {
  ui: FontReference | null;
  mono: FontReference | null;
  editorCjk: FontReference | null;
}

export interface FontInfo {
  reference: FontReference;
  name: string;
  monospaced: boolean;
  format?: string;
  bytes?: number;
}

export interface FontCatalogue {
  version: 1;
  items: FontInfo[];
}

export interface FontImport {
  token: string;
  font: FontInfo;
}

export const DEFAULT_FONT_SELECTIONS: FontSelections = { ui: null, mono: null, editorCjk: null };

export function fontKey(reference: FontReference | null): string {
  if (!reference) return "";
  return reference.source === "system" ? `system:${reference.family}` : `imported:${reference.id}`;
}

export function sameFont(a: FontReference | null, b: FontReference | null): boolean {
  return fontKey(a) === fontKey(b);
}
