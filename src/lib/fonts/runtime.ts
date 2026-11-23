import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_FONT_SELECTIONS, fontKey, type FontReference, type FontSelections } from "./types";

export const FONT_READY_EVENT = "td-fonts-ready";
export const AUTO_CJK_SOURCE = [
  "PingFang SC",
  "Microsoft YaHei",
  "Noto Sans CJK SC",
  "Noto Sans SC",
  "Source Han Sans SC",
  "WenQuanYi Zen Hei",
  "Hiragino Sans GB",
  "SimSun",
  "Droid Sans Fallback",
]
  .map((name) => `local(${JSON.stringify(name)})`)
  .join(",");

const faces = new Map<string, { face: FontFace; ready: Promise<boolean> }>();
let selected: FontSelections = DEFAULT_FONT_SELECTIONS;
let selectedKey = "";
let ready: Promise<unknown> = Promise.resolve();
let listening = false;
let generation = 0;

export function fontGeneration(): number {
  return generation;
}

export function fontResource(id: string): string {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? convertFileSrc(id, "tunnelde-font")
    : `tunnelde-font://localhost/${id}`;
}

export function fontFamily(reference: FontReference): string {
  return reference.source === "system" ? reference.family : `Tunnelde Imported ${reference.id}`;
}

export function fontSource(reference: FontReference): string {
  return reference.source === "system"
    ? `local(${JSON.stringify(reference.family)})`
    : `url(${JSON.stringify(fontResource(reference.id))})`;
}

export function cjkFontSource(reference: FontReference | null): string {
  return reference ? fontSource(reference) : AUTO_CJK_SOURCE;
}

/** Register imported fonts in each document before measuring or displaying them. */
export function ensureFont(reference: FontReference | null): Promise<boolean> {
  if (!reference) return Promise.resolve(true);
  if (typeof FontFace === "undefined" || !document.fonts?.add) return Promise.resolve(false);
  const key = fontKey(reference);
  const existing = faces.get(key);
  if (existing) return existing.ready;
  // A local probe resolves the actual installed font rather than relying on
  // document.fonts.check(), which also succeeds for missing font families.
  const face = new FontFace(
    reference.source === "system" ? `Tunnelde Probe ${key}` : fontFamily(reference),
    fontSource(reference),
  );
  const entry = { face, ready: Promise.resolve(false) };
  entry.ready = face
    .load()
    .then(() => {
      if (reference.source === "imported" && faces.get(key) === entry) document.fonts.add(face);
      return true;
    })
    .catch(() => {
      if (faces.get(key) === entry) faces.delete(key);
      return false;
    });
  faces.set(key, entry);
  return entry.ready;
}

export function activateFonts(
  selections: FontSelections = DEFAULT_FONT_SELECTIONS,
  force = false,
): void {
  selected = selections;
  const key = JSON.stringify(selections);
  if (key !== selectedKey || force) {
    generation++;
    selectedKey = key;
    const keep = new Set(Object.values(selections).map(fontKey));
    for (const [id, entry] of faces) {
      if (!keep.has(id) || force) {
        document.fonts?.delete?.(entry.face);
        faces.delete(id);
      }
    }
    ready = Promise.all(Object.values(selections).map(ensureFont)).then(() => {
      if (selectedKey === key) window.dispatchEvent(new Event(FONT_READY_EVENT));
    });
  }
  if (!listening && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    listening = true;
    void listen("fonts://changed", () => activateFonts(selected, true)).catch(() => {
      listening = false;
    });
  }
}

export function selectedFontsReady(): Promise<unknown> {
  return ready;
}

/** Return a disposable face for import validation and catalogue previews. */
export async function previewFont(
  reference: FontReference,
  token?: string,
): Promise<{ family: string; monospaced: boolean; dispose(): void }> {
  const family = `Tunnelde Preview ${crypto.randomUUID()}`;
  const source = token
    ? `url(${JSON.stringify(fontResource(`staged-${token}`))})`
    : fontSource(reference);
  const face = new FontFace(family, source);
  await face.load();
  document.fonts.add(face);
  const context = document.createElement("canvas").getContext("2d");
  if (context) context.font = `100px ${JSON.stringify(family)}`;
  const widths = ["i", "W", "0", " "].map((text) => context?.measureText(text).width ?? 0);
  const first = widths[0] ?? 0;
  const monospaced = first > 0 && widths.every((width) => Math.abs(width - first) < 0.1);
  return {
    family,
    monospaced,
    dispose: () => {
      document.fonts.delete(face);
    },
  };
}
