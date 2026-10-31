// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect } from "react";
import { flushSync } from "react-dom";

interface PointerDrag {
  source: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  draggable: string | null;
  transfer: DataTransfer | null;
  target: Element | null;
  preview: HTMLElement | null;
  accepted: boolean;
  userSelect: string;
  cursor: string;
}

/**
 * WebView2's native file drop target intercepts HTML drag and drop. Drive the
 * app's existing drag handlers with pointer events so external OS file drops
 * remain enabled without sacrificing internal file, host and tab dragging.
 */
export function useInternalDrag(): void {
  useEffect(() => installInternalDrag(), []);
}

/** Exported separately to exercise the browser event lifecycle in tests. */
export function installInternalDrag(): () => void {
  let drag: PointerDrag | null = null;
  let suppressClick: { x: number; y: number; until: number } | null = null;

  const emit = (target: Element, type: string, event: PointerEvent | MouseEvent) => {
    const transfer = drag?.transfer;
    if (!transfer) return false;
    const synthetic = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      button: 0,
      buttons: type === "dragend" || type === "drop" ? 0 : 1,
    });
    let accepted = false;
    flushSync(() => {
      accepted = !target.dispatchEvent(synthetic);
    });
    return accepted;
  };

  const cleanup = (event?: PointerEvent | MouseEvent) => {
    const current = drag;
    if (!current) return;
    if (current.transfer && event) {
      emit(current.source, "dragend", event);
      // A successful cross-group drop may already have unmounted its source.
      if (!current.source.isConnected) emit(document.documentElement, "dragend", event);
    }
    if (current.draggable === null) current.source.removeAttribute("draggable");
    else current.source.setAttribute("draggable", current.draggable);
    current.preview?.remove();
    if (current.transfer) {
      document.body.style.userSelect = current.userSelect;
      document.body.style.cursor = current.cursor;
    }
    drag = null;
  };

  const start = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest("input, textarea, select, button, a, [contenteditable='true']"))
      return;
    const source = element.closest<HTMLElement>("[draggable='true']");
    if (!source) return;
    cleanup(event);
    suppressClick = null;
    drag = {
      source,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      draggable: source.getAttribute("draggable"),
      transfer: null,
      target: null,
      preview: null,
      accepted: false,
      userSelect: document.body.style.userSelect,
      cursor: document.body.style.cursor,
    };
    // Do not prevent pointerdown: ordinary clicks and keyboard focus still work.
    source.draggable = false;
  };

  const move = (event: PointerEvent) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.transfer) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
      current.transfer = new DataTransfer();
      if (emit(current.source, "dragstart", event)) {
        cleanup(event);
        return;
      }
      if (current.transfer.types.length === 0) {
        cleanup(event);
        return;
      }
      document.body.style.userSelect = "none";
      const preview = current.source.cloneNode(true) as HTMLElement;
      preview.removeAttribute("id");
      preview.removeAttribute("draggable");
      preview.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      preview.setAttribute("aria-hidden", "true");
      preview.dataset.dragPreview = "true";
      Object.assign(preview.style, {
        position: "fixed",
        pointerEvents: "none",
        zIndex: "2147483647",
        width: `${Math.min(280, Math.max(100, current.source.getBoundingClientRect().width))}px`,
        height: "28px",
        overflow: "hidden",
        opacity: "0.9",
        background: "var(--td-elevated, #202630)",
        color: "var(--td-text, white)",
        border: "1px solid var(--td-border, #555)",
        borderRadius: "4px",
        boxShadow: "0 4px 14px #0005",
        margin: "0",
      });
      document.body.appendChild(preview);
      current.preview = preview;
    }
    event.preventDefault();
    if (current.preview) {
      current.preview.style.left = `${event.clientX + 12}px`;
      current.preview.style.top = `${event.clientY + 12}px`;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (current.target !== target) {
      if (current.target) emit(current.target, "dragleave", event);
      current.target = target;
      if (target) emit(target, "dragenter", event);
    }
    current.transfer!.dropEffect = "none";
    current.accepted = target ? emit(target, "dragover", event) : false;
    document.body.style.cursor = current.accepted
      ? String(current.transfer!.dropEffect) === "copy"
        ? "copy"
        : "grabbing"
      : "not-allowed";
  };

  const finish = (event: PointerEvent) => {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.transfer) {
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (target && emit(target, "dragover", event)) emit(target, "drop", event);
      if (current.target) emit(current.target, "dragleave", event);
      suppressClick = { x: event.clientX, y: event.clientY, until: performance.now() + 350 };
    }
    cleanup(event);
  };

  const cancel = (event: PointerEvent | KeyboardEvent) => {
    if (!drag) return;
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    if (event instanceof PointerEvent && event.pointerId !== drag.pointerId) return;
    if (drag.transfer) {
      event.preventDefault();
      event.stopPropagation();
      const position = new MouseEvent("dragend", { clientX: drag.startX, clientY: drag.startY });
      if (drag.target) emit(drag.target, "dragleave", position);
      cleanup(position);
    } else cleanup();
  };

  const click = (event: MouseEvent) => {
    if (!suppressClick || event.detail === 0) return;
    const blocked =
      performance.now() < suppressClick.until &&
      Math.hypot(event.clientX - suppressClick.x, event.clientY - suppressClick.y) < 5;
    suppressClick = null;
    if (blocked) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  const blur = () => cleanup(new MouseEvent("dragend"));
  document.addEventListener("pointerdown", start, true);
  document.addEventListener("pointermove", move, { capture: true, passive: false });
  document.addEventListener("pointerup", finish, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("keydown", cancel, true);
  document.addEventListener("click", click, true);
  window.addEventListener("blur", blur);
  return () => {
    document.removeEventListener("pointerdown", start, true);
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", finish, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("keydown", cancel, true);
    document.removeEventListener("click", click, true);
    window.removeEventListener("blur", blur);
    cleanup();
  };
}
