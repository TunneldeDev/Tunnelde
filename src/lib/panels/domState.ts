/** Explicitly marked DOM geometry/caret state. No input values, HTML, selectors
 * from plugins, credentials or persisted storage are transported here. */
export interface PanelDomState {
  version: 1;
  scroll: Record<string, { left: number; top: number }>;
  focus: {
    key: string;
    selection?: { start: number; end: number; direction: "forward" | "backward" | "none" };
  } | null;
}
const validKey = (key: unknown): key is string =>
  typeof key === "string" &&
  key.length > 0 &&
  key.length <= 128 &&
  /^[a-zA-Z0-9._:-]+$/.test(key) &&
  !["__proto__", "constructor", "prototype"].includes(key);
function marked(root: HTMLElement, attribute: "data-panel-scroll" | "data-panel-focus") {
  const items = new Map<string, HTMLElement>();
  const elements = [
    ...(root.hasAttribute(attribute) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(`[${attribute}]`),
  ];
  if (elements.length > 128) throw new Error("panel.viewState.tooManyFields");
  for (const element of elements) {
    const key = element.getAttribute(attribute)!;
    if (!validKey(key) || items.has(key)) throw new Error("panel.viewState.invalidKey");
    items.set(key, element);
  }
  return items;
}
function textField(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}
export function capturePanelDomState(root: HTMLElement): PanelDomState {
  const scroll = Object.fromEntries(
    [...marked(root, "data-panel-scroll")].map(([key, element]) => [
      key,
      { left: element.scrollLeft, top: Math.max(0, element.scrollTop) },
    ]),
  );
  let focus: PanelDomState["focus"] = null;
  for (const [key, element] of marked(root, "data-panel-focus")) {
    if (element !== root.ownerDocument.activeElement) continue;
    focus = { key };
    if (textField(element) && element.selectionStart !== null && element.selectionEnd !== null) {
      focus.selection = {
        start: element.selectionStart,
        end: element.selectionEnd,
        direction: element.selectionDirection ?? "none",
      };
    }
    break;
  }
  return { version: 1, scroll, focus };
}
const coordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2 ** 31 - 1;
export function parsePanelDomState(value: unknown): PanelDomState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("panel.viewState.invalid");
  const state = value as Partial<PanelDomState>;
  if (
    state.version !== 1 ||
    !state.scroll ||
    typeof state.scroll !== "object" ||
    Array.isArray(state.scroll)
  )
    throw new Error("panel.viewState.invalid");
  const entries = Object.entries(state.scroll);
  if (
    entries.length > 128 ||
    entries.some(
      ([key, point]) =>
        !validKey(key) ||
        !point ||
        !(
          typeof point.left === "number" &&
          Number.isFinite(point.left) &&
          Math.abs(point.left) <= 2 ** 31 - 1
        ) ||
        !coordinate(point.top),
    )
  )
    throw new Error("panel.viewState.invalid");
  const focus = state.focus;
  if (focus !== null) {
    if (!focus || typeof focus !== "object" || !validKey(focus.key))
      throw new Error("panel.viewState.invalid");
    const selection = focus.selection;
    if (
      selection !== undefined &&
      (!selection ||
        typeof selection !== "object" ||
        Array.isArray(selection) ||
        !coordinate(selection.start) ||
        !coordinate(selection.end) ||
        !Number.isInteger(selection.start) ||
        !Number.isInteger(selection.end) ||
        selection.start > selection.end ||
        !["forward", "backward", "none"].includes(selection.direction))
    )
      throw new Error("panel.viewState.invalid");
  }
  return {
    version: 1,
    scroll: Object.fromEntries(
      entries.map(([key, point]) => [key, { left: point.left, top: point.top }]),
    ),
    focus: focus
      ? { key: focus.key, ...(focus.selection ? { selection: { ...focus.selection } } : {}) }
      : null,
  };
}
export function restorePanelDomState(
  root: HTMLElement,
  snapshot: unknown,
  { focus = false }: { focus?: boolean } = {},
) {
  const state = parsePanelDomState(snapshot);
  const scroll = marked(root, "data-panel-scroll");
  for (const [key, point] of Object.entries(state.scroll)) {
    const element = scroll.get(key);
    if (!element) continue;
    const horizontal = Math.max(0, element.scrollWidth - element.clientWidth);
    // Modern native RTL scrolling uses negative offsets. Let the browser clamp
    // the signed value for its direction instead of forcing LTR semantics.
    element.scrollLeft = Math.max(-horizontal, Math.min(point.left, horizontal));
    element.scrollTop = Math.min(
      point.top,
      Math.max(0, element.scrollHeight - element.clientHeight),
    );
  }
  if (!state.focus) return;
  const element = marked(root, "data-panel-focus").get(state.focus.key);
  if (!element) return;
  if (textField(element) && state.focus.selection) {
    const { start, end, direction } = state.focus.selection;
    // The destination may have refreshed or changed field type while staging.
    try {
      element.setSelectionRange(
        Math.min(start, element.value.length),
        Math.min(end, element.value.length),
        direction,
      );
    } catch {
      /* Number/date controls have no selection API. */
    }
  }
  // A staged view restores geometry without stealing focus from its source.
  if (focus && !element.closest("[inert]") && !("disabled" in element && element.disabled))
    element.focus({ preventScroll: true });
}
