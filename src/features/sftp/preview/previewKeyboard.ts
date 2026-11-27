import type { KeyboardEvent } from "react";

/** Preview navigation belongs to the surface; editable and media controls keep their keys. */
export function previewKeyDown(
  event: KeyboardEvent,
  navigate: (direction: -1 | 1) => void,
  close: () => void,
) {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.nativeEvent.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return;
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest(
      'input, textarea, select, button, a, audio, video, [role="combobox"], [role="slider"], [role="listbox"], [role="menu"], [role="option"], [contenteditable="true"]',
    )
  )
    return;
  if (event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    navigate(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
  }
}
