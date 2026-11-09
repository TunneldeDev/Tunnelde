import type { Terminal } from "@xterm/xterm";

/** Accept TUI selection copies without granting remote programs clipboard read access. */
export function bindTerminalClipboard(
  terminal: Terminal,
  element: HTMLElement,
  enabled: () => boolean,
  writeText: (text: string) => Promise<void>,
  onError: () => void,
) {
  let disposed = false;
  let pressed = false;
  let copyGestureAt = -Infinity;
  const mouseDown = (event: MouseEvent) => {
    pressed = event.button === 0;
    // Some TUIs publish OSC 52 while selecting, before the final mouse release.
    if (pressed) copyGestureAt = performance.now();
  };
  const mouseUp = (event: MouseEvent) => {
    if (pressed && event.button === 0) copyGestureAt = performance.now();
    pressed = false;
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      !event.isComposing &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      (terminal.hasSelection() || terminal.modes.mouseTrackingMode !== "none")
    ) {
      copyGestureAt = performance.now();
    }
  };
  // Capture release before xterm forwards it to an application handling its own selection.
  element.addEventListener("mousedown", mouseDown, true);
  element.addEventListener("keydown", keyDown, true);
  document.addEventListener("mouseup", mouseUp, true);
  const handler = terminal.parser.registerOscHandler(52, (data) => {
    if (disposed || !enabled() || performance.now() - copyGestureAt > 10_000) return true;
    const separator = data.indexOf(";");
    if (separator < 0) return true;
    const target = data.slice(0, separator);
    const encoded = data.slice(separator + 1);
    // Never answer OSC 52 queries, accept primary-selection requests, or clear the clipboard.
    if (
      (target !== "" && target !== "c") ||
      encoded.length === 0 ||
      encoded.length > 100_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      return true;
    let text: string;
    try {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return true;
    }
    if (!text) return true;
    copyGestureAt = -Infinity;
    void writeText(text).catch(() => {
      if (!disposed) onError();
    });
    return true;
  });
  return {
    dispose: () => {
      disposed = true;
      element.removeEventListener("mousedown", mouseDown, true);
      element.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("mouseup", mouseUp, true);
      handler.dispose();
    },
  };
}
