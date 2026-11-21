import { createPanelCaptures, type AsyncPanelCapture, type PanelReady } from "./viewCapture";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

/** Ephemeral view data only. Never write this capsule to preferences or logs:
 * draft fields may contain passwords even though panel metadata does not. */
export interface PanelViewCapsule {
  version: 1;
  fields: Record<string, unknown>;
}
const MAX_BYTES = 1024 * 1024;
const MAX_FIELDS = 256;
function validKey(key: string) {
  return (
    key.length > 0 &&
    key.length <= 128 &&
    /^[a-zA-Z0-9._:-]+$/.test(key) &&
    !["__proto__", "prototype", "constructor"].includes(key)
  );
}
function capsule(fields: Record<string, unknown>): PanelViewCapsule {
  // Roundtrip once: IPC only transports JSON. Reject unrepresentable state,
  // rather than silently losing functions, nonfinite numbers or bigint drafts.
  const stack = new Set<object>();
  let nodes = 0,
    bytes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 10_000 || depth > 64) throw new Error("panel.viewState.tooLarge");
    if (typeof value === "string") {
      bytes += new TextEncoder().encode(value).length;
      if (bytes > MAX_BYTES) throw new Error("panel.viewState.tooLarge");
      return;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (!value || typeof value !== "object" || stack.has(value))
      throw new Error("panel.viewState.invalid");
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("panel.viewState.invalid");
    stack.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/.test(key)))
        throw new Error("panel.viewState.invalid");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || descriptor.get || descriptor.set)
        throw new Error("panel.viewState.invalid");
      visit(key, depth + 1);
      visit(descriptor.value, depth + 1);
    }
    if (array && Object.keys(value).length !== value.length)
      throw new Error("panel.viewState.invalid");
    stack.delete(value);
  };
  visit(fields, 0);
  const json = JSON.stringify({ version: 1, fields });
  if (new TextEncoder().encode(json).length > MAX_BYTES)
    throw new Error("panel.viewState.tooLarge");
  return JSON.parse(json) as PanelViewCapsule;
}
function parseCapsule(value: unknown, maxFields: number): PanelViewCapsule {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("panel.viewState.invalid");
  const candidate = value as Partial<PanelViewCapsule>;
  if (
    candidate.version !== 1 ||
    !candidate.fields ||
    typeof candidate.fields !== "object" ||
    Array.isArray(candidate.fields)
  )
    throw new Error("panel.viewState.invalid");
  const entries = Object.entries(candidate.fields);
  if (entries.length > maxFields || entries.some(([key]) => !validKey(key)))
    throw new Error("panel.viewState.invalid");
  return capsule(Object.fromEntries(entries));
}

export function parsePanelViewCapsule(value: unknown): PanelViewCapsule {
  return parseCapsule(value, MAX_FIELDS);
}
/** One controller per owned panel, not per native SSH/plugin resource. */
export function createPanelViewState(initial?: unknown) {
  return createController(initial, MAX_FIELDS);
}
function createController(initial: unknown, maxFields: number) {
  const incoming = initial === undefined ? {} : parseCapsule(initial, maxFields).fields;
  const captures = createPanelCaptures(maxFields, capsule);
  let disposed = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(changed: () => void) {
      if (disposed) throw new Error("panel.viewState.disposed");
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    changed() {
      if (!disposed) {
        captures.invalidate();
        for (const notify of listeners) notify();
      }
    },
    invalidate: captures.invalidate,
    read<T>(key: string, validate: (value: unknown) => value is T): T | undefined {
      if (disposed) throw new Error("panel.viewState.disposed");
      if (!validKey(key)) throw new Error("panel.viewState.invalidKey");
      const value = Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] : undefined;
      return validate(value) ? value : undefined;
    },
    register(
      key: string,
      capture: () => unknown,
      captureAsync?: AsyncPanelCapture,
      ready?: PanelReady,
    ) {
      if (disposed) throw new Error("panel.viewState.disposed");
      if (!validKey(key)) throw new Error("panel.viewState.invalidKey");
      const unregister = captures.register(key, { sync: capture, async: captureAsync, ready });
      return () => {
        if (unregister()) delete incoming[key];
      };
    },
    registerAsync(key: string, capture: AsyncPanelCapture, ready?: PanelReady) {
      if (disposed) throw new Error("panel.viewState.disposed");
      if (!validKey(key)) throw new Error("panel.viewState.invalidKey");
      const unregister = captures.register(key, { async: capture, ready });
      return () => {
        if (unregister()) delete incoming[key];
      };
    },
    capture: captures.capture,
    captureAsync: captures.captureAsync,
    hasReadiness: captures.hasReadiness,
    waitReady: captures.waitReady,
    dispose() {
      captures.dispose();
      listeners.clear();
      for (const key of Object.keys(incoming)) delete incoming[key];
      disposed = true;
    },
  };
}
export type PanelViewState = ReturnType<typeof createPanelViewState>;
const Context = createContext<PanelViewState | null>(null);
/** Host-internal binding for async view factories; not a plugin transport. */
export const usePanelViewController = () => useContext(Context);
export function PanelViewStateScope({
  controller,
  children,
}: {
  controller: PanelViewState;
  children: ReactNode;
}) {
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

/** Repeating rows share one parent capsule field rather than consuming a
 * top-level slot each. Nested state remains strict JSON and subject to the same
 * aggregate byte/node/depth bounds; nothing is truncated to make a move fit. */
export function PanelViewStateGroup({ name, children }: { name: string; children: ReactNode }) {
  const parent = useContext(Context);
  const [identity] = useState(() => ({ name, parent }));
  if (identity.name !== name || identity.parent !== parent)
    throw new Error("panel.viewState.identityChanged");
  const [controller] = useState(() => {
    if (!parent) return null;
    const initial = parent.read(name, (value): value is PanelViewCapsule => {
      try {
        parseCapsule(value, Infinity);
        return true;
      } catch {
        return false;
      }
    });
    return createController(initial, Infinity);
  });
  useLayoutEffect(() => {
    if (!parent || !controller) return;
    const unregister = parent.register(
      name,
      controller.capture,
      controller.captureAsync,
      controller.waitReady,
    );
    const stop = controller.subscribe(parent.changed);
    return () => {
      stop();
      unregister();
    };
  }, [parent, controller, name]);
  return controller ? <Context.Provider value={controller}>{children}</Context.Provider> : children;
}

/** Explicitly opt local UI state into a cross-WebView handoff. No provider means
 * normal local React state, so features need not know their presentation mode.
 * Keys must be stable and unique inside a panel. Validators reject old schemas. */
export function usePanelViewState<T>(
  key: string,
  initial: T | (() => T),
  validate: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const controller = useContext(Context);
  const [identity] = useState(() => ({ key, controller }));
  if (identity.key !== key || identity.controller !== controller)
    throw new Error("panel.viewState.identityChanged");
  const [value, setValue] = useState<T>(() => {
    const restored = controller?.read(key, validate);
    return restored !== undefined
      ? restored
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial;
  });
  const current = useRef(value);
  useLayoutEffect(() => {
    current.current = value;
    controller?.changed();
  }, [controller, value]);
  useLayoutEffect(() => controller?.register(key, () => current.current), [controller, key]);
  return [value, setValue];
}
