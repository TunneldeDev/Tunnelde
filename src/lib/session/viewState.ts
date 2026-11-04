import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

const values = new Map<string, unknown>();
const guards = new Set<() => boolean>();
const elements = new Map<string, () => unknown>();

/** Capture caret and scrolling without React updates for every scroll event. */
export function useViewElementState(
  key: string,
  element: { readonly current: HTMLElement | null },
  ready = true,
) {
  useLayoutEffect(() => {
    const target = element.current;
    if (!ready || !target) return;
    const restored = values.get(key) as
      | {
          top: number;
          left: number;
          start?: number;
          end?: number;
          direction?: "forward" | "backward" | "none";
        }
      | undefined;
    if (restored) {
      target.scrollTo({ top: restored.top, left: restored.left, behavior: "instant" });
      if (target instanceof HTMLTextAreaElement && restored.start !== undefined) {
        target.setSelectionRange(
          restored.start,
          restored.end ?? restored.start,
          restored.direction,
        );
      }
    }
    elements.set(key, () => ({
      top: target.scrollTop,
      left: target.scrollLeft,
      ...(target instanceof HTMLTextAreaElement
        ? {
            start: target.selectionStart,
            end: target.selectionEnd,
            direction: target.selectionDirection,
          }
        : {}),
    }));
    return () => {
      elements.delete(key);
      values.delete(key);
    };
  }, [key, element, ready]);
}

/** View drafts survive WebView suspension in native memory, never localStorage. */
export function useViewState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [state, update] = useState<T>(() =>
    values.has(key)
      ? (values.get(key) as T)
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial,
  );
  const current = useRef(state);
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const value =
        typeof next === "function" ? (next as (previous: T) => T)(current.current) : next;
      current.current = value;
      values.set(key, value);
      update(value);
    },
    [key],
  );
  useLayoutEffect(() => {
    values.set(key, current.current);
    return () => {
      values.delete(key);
    };
  }, [key]);
  return [state, set];
}

/** Finish in-flight view-owned writes/dialogs before releasing their WebView. */
export function useBackgroundGuard(blocked: boolean) {
  const current = useRef(blocked);
  useLayoutEffect(() => {
    current.current = blocked;
  }, [blocked]);
  useLayoutEffect(() => {
    const guard = () => current.current;
    guards.add(guard);
    return () => {
      guards.delete(guard);
    };
  }, []);
}

export function viewIsBusy() {
  return [...guards].some((guard) => guard());
}

export function viewStateSnapshot() {
  return {
    ...Object.fromEntries(values),
    ...Object.fromEntries([...elements].map(([key, read]) => [key, read()])),
  };
}

export function restoreViewState(snapshot: Record<string, unknown>) {
  values.clear();
  Object.entries(snapshot).forEach(([key, value]) => values.set(key, value));
}

// Host-tree expansion and a few view caches use Sets/Maps. These remain typed
// through JSON without granting plugins arbitrary object revival.
export function encodeViewSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, value: unknown) =>
    value instanceof Set
      ? { $viewType: "Set", values: [...value] }
      : value instanceof Map
        ? { $viewType: "Map", values: [...value] }
        : value,
  );
}

export function decodeViewSnapshot<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("$viewType" in value) ||
      !("values" in value) ||
      !Array.isArray(value.values)
    )
      return value;
    if (value.$viewType === "Set") return new Set(value.values);
    if (value.$viewType === "Map") return new Map(value.values);
    return value;
  }) as T;
}
