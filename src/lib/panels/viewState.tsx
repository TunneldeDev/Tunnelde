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
export function parsePanelViewCapsule(value: unknown): PanelViewCapsule {
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
  if (entries.length > MAX_FIELDS || entries.some(([key]) => !validKey(key)))
    throw new Error("panel.viewState.invalid");
  return capsule(Object.fromEntries(entries));
}

/** One controller per owned panel, not per native SSH/plugin resource. */
export function createPanelViewState(initial?: unknown) {
  const incoming = initial === undefined ? {} : parsePanelViewCapsule(initial).fields;
  const fields = new Map<string, { token: symbol; capture: () => unknown }>();
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
      if (!disposed) for (const notify of listeners) notify();
    },
    read<T>(key: string, validate: (value: unknown) => value is T): T | undefined {
      if (disposed) throw new Error("panel.viewState.disposed");
      if (!validKey(key)) throw new Error("panel.viewState.invalidKey");
      const value = Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] : undefined;
      return validate(value) ? value : undefined;
    },
    register(key: string, capture: () => unknown) {
      if (disposed) throw new Error("panel.viewState.disposed");
      if (!validKey(key)) throw new Error("panel.viewState.invalidKey");
      if (fields.has(key)) throw new Error("panel.viewState.duplicateKey");
      if (fields.size >= MAX_FIELDS) throw new Error("panel.viewState.tooManyFields");
      const token = Symbol(key);
      fields.set(key, { token, capture });
      return () => {
        if (fields.get(key)?.token !== token) return;
        fields.delete(key);
        // A closed dialog must not revive an old credential draft on reopening.
        delete incoming[key];
      };
    },
    capture(): PanelViewCapsule {
      if (disposed) throw new Error("panel.viewState.disposed");
      return capsule(Object.fromEntries([...fields].map(([key, field]) => [key, field.capture()])));
    },
    dispose() {
      fields.clear();
      listeners.clear();
      for (const key of Object.keys(incoming)) delete incoming[key];
      disposed = true;
    },
  };
}
export type PanelViewState = ReturnType<typeof createPanelViewState>;
const Context = createContext<PanelViewState | null>(null);
export function PanelViewStateScope({
  controller,
  children,
}: {
  controller: PanelViewState;
  children: ReactNode;
}) {
  return <Context.Provider value={controller}>{children}</Context.Provider>;
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
