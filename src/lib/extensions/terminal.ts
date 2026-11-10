import type { Terminal } from "@xterm/xterm";
import type {
  FrontendTerminal,
  FrontendTerminalChange,
  FrontendTerminalSnapshot,
} from "./uiSdkContract";

type Change = FrontendTerminalChange["changes"][number];
type Metadata = Pick<FrontendTerminalSnapshot, "hostId" | "title" | "status">;
const MAX_TEXT = 65536;

/** A host-owned terminal. No xterm instance, private store or SSH handle crosses the SDK. */
export function createTerminalBridge(sessionId: string, report: (error: unknown) => void) {
  let instance: Terminal | null = null;
  let disposed = false;
  let revision = 0;
  let metadata: Metadata = { hostId: null, title: "", status: "starting" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Map<(change: Readonly<FrontendTerminalChange>) => void, () => void>();
  const pending = new Set<Change>();
  const alive = () => {
    if (disposed) throw new Error("plugin.terminal.unavailable");
  };
  const terminal = (input = false) => {
    alive();
    if (
      !instance ||
      metadata.status === "starting" ||
      metadata.status === "suspended" ||
      (input && metadata.status !== "ready")
    )
      throw new Error("plugin.terminal.unavailable");
    return instance;
  };
  const notify = (change: Change) => {
    if (disposed) return;
    revision++;
    if (!listeners.size) return;
    pending.add(change);
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const event = Object.freeze({ revision, changes: Object.freeze([...pending]) });
      pending.clear();
      for (const [receive, release] of [...listeners]) {
        if (!listeners.has(receive)) continue;
        try {
          receive(event);
        } catch (error) {
          release();
          report(error);
        }
      }
    }, 100);
  };
  const validateText = (text: string) => {
    if (typeof text !== "string" || !text || text.length > MAX_TEXT)
      throw new Error("plugin.terminal.invalid");
  };
  const api: Omit<FrontendTerminal, "Screen"> = Object.freeze({
    readState: () => {
      alive();
      const buffer = instance?.buffer.active;
      return Object.freeze({
        sessionId,
        ...metadata,
        revision,
        cols: instance?.cols ?? 0,
        rows: instance?.rows ?? 0,
        buffer: buffer?.type ?? "normal",
        totalLines: buffer?.length ?? 0,
        viewportY: buffer?.viewportY ?? 0,
      });
    },
    readLines: (request = {}) => {
      const current = terminal();
      if (request === null || typeof request !== "object")
        throw new Error("plugin.terminal.invalid");
      if (request.revision !== undefined && request.revision !== revision)
        throw new Error("plugin.terminal.changed");
      const buffer = current.buffer.active;
      const offset = request.offset ?? buffer.viewportY;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
        throw new Error("plugin.terminal.invalid");
      const lines: { row: number; text: string; wrapped: boolean; truncated: boolean }[] = [];
      let size = 0,
        row = offset;
      for (; row < buffer.length && lines.length < 128; row++) {
        const line = buffer.getLine(row)!;
        // Bound translation work as well as the public result. Each cell can contain a grapheme.
        const text = line.translateToString(true, 0, Math.min(current.cols, 4096));
        const value = text.slice(0, 4096);
        // Leave a whole row for the next page rather than silently dropping its tail.
        if (size + value.length > MAX_TEXT) break;
        lines.push(
          Object.freeze({
            row,
            text: value,
            wrapped: line.isWrapped,
            truncated: value.length < text.length || current.cols > 4096,
          }),
        );
        size += value.length;
        if (size === MAX_TEXT) {
          row++;
          break;
        }
      }
      return Object.freeze({
        revision,
        offset,
        total: buffer.length,
        nextOffset: row < buffer.length ? row : null,
        lines: Object.freeze(lines),
      });
    },
    subscribe: (receive, options = {}) => {
      alive();
      if (typeof receive !== "function") throw new Error("plugin.terminal.invalid");
      if (
        !options ||
        typeof options !== "object" ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      )
        throw new Error("plugin.terminal.invalid");
      if (options.signal?.aborted) return () => {};
      if (listeners.size >= 16) throw new Error("plugin.terminal.subscriptionLimit");
      // A callback can be registered more than once without overwriting its release hook.
      const wrapped = (event: Readonly<FrontendTerminalChange>) => receive(event);
      const release = () => {
        listeners.delete(wrapped);
        options.signal?.removeEventListener("abort", release);
        if (!listeners.size) {
          clearTimeout(timer);
          timer = undefined;
          pending.clear();
        }
      };
      listeners.set(wrapped, release);
      options.signal?.addEventListener("abort", release, { once: true });
      return release;
    },
    readSelection: () => {
      const text = terminal().getSelection();
      return Object.freeze({ text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT });
    },
    focus: () => terminal().focus(),
    paste: (text) => {
      validateText(text);
      terminal(true).paste(text);
    },
    send: (text) => {
      validateText(text);
      terminal(true).input(text, true);
    },
    scrollToLine: (row) => {
      const current = terminal();
      if (!Number.isSafeInteger(row) || row < 0 || row >= current.buffer.active.length)
        throw new Error("plugin.terminal.invalid");
      current.scrollToLine(row);
    },
    clearSelection: () => terminal().clearSelection(),
  });
  return {
    sessionId,
    api,
    update: (change: Partial<Metadata>) => {
      const next = { ...metadata, ...change };
      if (
        disposed ||
        (next.hostId === metadata.hostId &&
          next.title === metadata.title &&
          next.status === metadata.status)
      )
        return;
      metadata = { hostId: next.hostId, title: next.title, status: next.status };
      notify("status");
    },
    attach: (next: Terminal) => {
      alive();
      if (instance) throw new Error("plugin.terminal.unavailable");
      instance = next;
      const subscriptions = [
        next.onWriteParsed(() => notify("output")),
        next.onSelectionChange(() => notify("selection")),
        next.onScroll(() => notify("scroll")),
        next.onResize(() => notify("resize")),
      ];
      notify("status");
      return () => {
        subscriptions.forEach((s) => s.dispose());
        if (instance === next) instance = null;
        notify("status");
      };
    },
    dispose: () => {
      disposed = true;
      instance = null;
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
      for (const release of [...listeners.values()]) release();
    },
  };
}
export type TerminalBridge = ReturnType<typeof createTerminalBridge>;
