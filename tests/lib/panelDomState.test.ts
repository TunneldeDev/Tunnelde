import { afterEach, expect, it } from "vitest";
import {
  capturePanelDomState,
  parsePanelDomState,
  restorePanelDomState,
} from "@/lib/panels/domState";
afterEach(() => document.body.replaceChildren());
function fixture() {
  const root = document.createElement("section");
  root.dataset.panelScroll = "body";
  root.innerHTML =
    '<input data-panel-focus="search" value="private draft"><div data-panel-scroll="list"></div><button data-panel-focus="add">Add</button>';
  document.body.append(root);
  const input = root.querySelector("input")!,
    list = root.querySelector<HTMLElement>("div")!;
  for (const element of [root, list]) {
    Object.defineProperties(element, {
      scrollWidth: { value: 800 },
      clientWidth: { value: 300 },
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    });
  }
  return { root, input, list, button: root.querySelector("button")! };
}
it("captures explicit geometry and caret without HTML or field values", () => {
  const { root, input, list } = fixture();
  root.scrollTop = 80;
  list.scrollLeft = 120;
  input.focus();
  input.setSelectionRange(2, 7, "backward");
  const state = capturePanelDomState(root);
  expect(state.scroll).toEqual({ body: { left: 0, top: 80 }, list: { left: 120, top: 0 } });
  expect(state.focus).toEqual({
    key: "search",
    selection: { start: 2, end: 7, direction: "backward" },
  });
  expect(JSON.stringify(state)).not.toContain("private draft");
  input.value = "new";
  root.scrollTop = 0;
  list.scrollLeft = 0;
  restorePanelDomState(root, state);
  expect(input.value).toBe("new");
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(3);
  expect(root.scrollTop).toBe(80);
  expect(list.scrollLeft).toBe(120);
});
it("never focuses staged/inert/disabled controls and focuses only after commit", () => {
  const { root, input, button } = fixture();
  input.focus();
  const state = capturePanelDomState(root);
  button.focus();
  restorePanelDomState(root, state);
  expect(document.activeElement).toBe(button);
  root.setAttribute("inert", "");
  restorePanelDomState(root, state, { focus: true });
  expect(document.activeElement).toBe(button);
  root.removeAttribute("inert");
  input.disabled = true;
  restorePanelDomState(root, state, { focus: true });
  expect(document.activeElement).toBe(button);
  input.disabled = false;
  restorePanelDomState(root, state, { focus: true });
  expect(document.activeElement).toBe(input);
});
it("clamps changing scroll geometry and ignores removed or changed fields", () => {
  const { root, input, list } = fixture();
  input.focus();
  const state = capturePanelDomState(root);
  state.scroll.body = { left: 99999, top: 99999 };
  state.scroll.gone = { left: 10, top: 10 };
  input.type = "number";
  restorePanelDomState(root, state);
  expect(root.scrollTop).toBe(800);
  expect(root.scrollLeft).toBe(500);
  input.remove();
  list.remove();
  expect(() => restorePanelDomState(root, state)).not.toThrow();
});
it("rejects invalid or duplicate stable markers instead of restoring the wrong control", () => {
  const { root, input } = fixture();
  const duplicate = input.cloneNode() as HTMLElement;
  root.append(duplicate);
  expect(() => capturePanelDomState(root)).toThrow("invalidKey");
  duplicate.remove();
  input.dataset.panelFocus = "__proto__";
  expect(() => capturePanelDomState(root)).toThrow("invalidKey");
});
it("rejects corrupt coordinates, focus schema and future versions", () => {
  for (const state of [
    null,
    { version: 2, scroll: {}, focus: null },
    { version: 1, scroll: { x: { left: Infinity, top: 0 } }, focus: null },
    {
      version: 1,
      scroll: {},
      focus: { key: "search", selection: { start: 5, end: 1, direction: "none" } },
    },
    {
      version: 1,
      scroll: {},
      focus: { key: "search", selection: { start: 0.5, end: 1, direction: "none" } },
    },
    { version: 1, scroll: {}, focus: { key: "constructor" } },
  ])
    expect(() => parsePanelDomState(state)).toThrow();
});
it("retains signed native RTL offsets rather than forcing an LTR scroll model", () => {
  const { root, list } = fixture();
  list.dir = "rtl";
  list.scrollLeft = -120;
  const state = capturePanelDomState(root);
  list.scrollLeft = 0;
  restorePanelDomState(root, state);
  expect(list.scrollLeft).toBe(-120);
  state.scroll.list = { left: -99999, top: 0 };
  restorePanelDomState(root, state);
  expect(list.scrollLeft).toBe(-500);
});
