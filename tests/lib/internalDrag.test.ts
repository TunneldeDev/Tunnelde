import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installInternalDrag } from "@/lib/session/useInternalDrag";

class TestTransfer {
  data: Record<string, string> = {};
  effectAllowed = "none";
  dropEffect = "none";
  get types() {
    return Object.keys(this.data);
  }
  setData(key: string, value: string) {
    this.data[key] = value;
  }
  getData(key: string) {
    return this.data[key] ?? "";
  }
}

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, options: PointerEventInit) {
    super(type, options);
    this.pointerId = options.pointerId ?? 1;
    this.pointerType = options.pointerType ?? "mouse";
    this.isPrimary = options.isPrimary ?? true;
  }
}

class TestDragEvent extends MouseEvent {
  dataTransfer: DataTransfer | null;
  constructor(type: string, options: DragEventInit) {
    super(type, options);
    this.dataTransfer = options.dataTransfer ?? null;
  }
}

let dispose: () => void;
let source: HTMLElement;
let target: HTMLElement;

const pointer = (node: EventTarget, type: string, x: number, y = 20) => {
  node.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
};

beforeEach(() => {
  vi.stubGlobal("DataTransfer", TestTransfer);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("DragEvent", TestDragEvent);
  document.body.innerHTML =
    '<div id="source" draggable="true"><span>file.txt</span><button>Close</button></div><div id="target"></div>';
  source = document.getElementById("source")!;
  target = document.getElementById("target")!;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => target),
  });
  source.addEventListener("dragstart", (event) =>
    (event as DragEvent).dataTransfer!.setData("application/x-tunnelde-file", "file.txt"),
  );
  dispose = installInternalDrag();
});

afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("internal pointer drag", () => {
  it("keeps an ordinary click native and restores draggable", () => {
    const started = vi.fn();
    source.addEventListener("dragstart", started);
    pointer(source, "pointerdown", 10);
    expect(source.draggable).toBe(false);
    pointer(document, "pointermove", 12);
    pointer(source, "pointerup", 12);
    expect(started).not.toHaveBeenCalled();
    expect(source.draggable).toBe(true);
  });

  it("delivers data to an accepting drop target without the OS drag subsystem", () => {
    const drop = vi.fn((event: Event) =>
      expect((event as DragEvent).dataTransfer!.getData("application/x-tunnelde-file")).toBe(
        "file.txt",
      ),
    );
    target.addEventListener("dragover", (event) => event.preventDefault());
    target.addEventListener("drop", drop);
    pointer(source, "pointerdown", 10);
    pointer(document, "pointermove", 30);
    expect(document.querySelector("[data-drag-preview]")).toBeTruthy();
    pointer(document, "pointerup", 30);
    expect(drop).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-drag-preview]")).toBeNull();
    expect(source.draggable).toBe(true);
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 30,
      clientY: 20,
    });
    const clicked = vi.fn();
    target.addEventListener("click", clicked);
    target.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1, clientX: 60, clientY: 20 }),
    );
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("refuses drops outside a target which accepts dragover", () => {
    const drop = vi.fn();
    target.addEventListener("drop", drop);
    pointer(source, "pointerdown", 10);
    pointer(document, "pointermove", 30);
    pointer(document, "pointerup", 30);
    expect(drop).not.toHaveBeenCalled();
  });

  it("cancels with Escape and cleans up the preview and styles", () => {
    const ended = vi.fn();
    source.addEventListener("dragend", ended);
    pointer(source, "pointerdown", 10);
    pointer(document, "pointermove", 30);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(ended).toHaveBeenCalledOnce();
    expect(source.draggable).toBe(true);
    expect(document.body.style.userSelect).toBe("");
    expect(document.querySelector("[data-drag-preview]")).toBeNull();
  });

  it("does not hijack form controls inside draggable rows", () => {
    const button = source.querySelector("button")!;
    pointer(button, "pointerdown", 10);
    pointer(document, "pointermove", 30);
    expect(source.draggable).toBe(true);
    expect(document.querySelector("[data-drag-preview]")).toBeNull();
  });

  it("leaves column and panel separators to their resize handlers", () => {
    source.insertAdjacentHTML("beforeend", '<span role="separator"><span>Resize</span></span>');
    const separator = source.querySelector('[role="separator"]')!;
    const resizing = vi.fn();
    const started = vi.fn();
    separator.addEventListener("pointerdown", resizing);
    source.addEventListener("dragstart", started);
    pointer(separator.firstElementChild!, "pointerdown", 10);
    pointer(document, "pointermove", 90);
    pointer(document, "pointerup", 90);
    expect(resizing).toHaveBeenCalledOnce();
    expect(started).not.toHaveBeenCalled();
    expect(source.draggable).toBe(true);
    expect(document.querySelector("[data-drag-preview]")).toBeNull();
  });

  it("abandons a missing release when the next move reports no pressed button", () => {
    const started = vi.fn();
    const dropped = vi.fn();
    source.addEventListener("dragstart", started);
    target.addEventListener("drop", dropped);
    pointer(source, "pointerdown", 10);
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: 100,
        clientY: 20,
        buttons: 0,
      }),
    );
    pointer(document, "pointermove", 200);
    pointer(document, "pointerup", 200);
    expect(started).not.toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
    expect(source.draggable).toBe(true);
  });

  it("clears a stale row gesture before a new press on a resize handle", () => {
    source.insertAdjacentHTML("beforeend", '<span role="separator">Resize</span>');
    const started = vi.fn();
    source.addEventListener("dragstart", started);
    pointer(source, "pointerdown", 10);
    pointer(source.querySelector('[role="separator"]')!, "pointerdown", 100);
    pointer(document, "pointermove", 200);
    pointer(document, "pointerup", 200);
    expect(started).not.toHaveBeenCalled();
    expect(source.draggable).toBe(true);
  });

  it("notifies document listeners even when the drop removes the source", () => {
    const ended = vi.fn();
    document.addEventListener("dragend", ended, { once: true });
    target.addEventListener("dragover", (event) => event.preventDefault());
    target.addEventListener("drop", () => source.remove());
    pointer(source, "pointerdown", 10);
    pointer(document, "pointermove", 30);
    pointer(document, "pointerup", 30);
    expect(ended).toHaveBeenCalledOnce();
  });
});
