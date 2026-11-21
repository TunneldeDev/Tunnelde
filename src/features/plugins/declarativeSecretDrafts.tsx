import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePanelViewController } from "@/lib/panels/viewState";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowViewRecord } from "@/lib/panels/windowViews";

interface Binding {
  client: PanelWindowClient | null;
  record?: WindowViewRecord;
}
const Context = createContext<Binding | null>(null);
/** Main-only password drafts deliberately bypass the suspension snapshot. */
const mainSecrets = new Map<string, unknown>();

function boundedKey(value: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `declarative.secret:${(hash >>> 0).toString(16)}`;
}

function target(record: WindowViewRecord) {
  return record.staged
    ? ({ kind: "staged", id: record.key } as const)
    : record.lease
      ? ({ kind: "owned", lease: record.lease } as const)
      : null;
}

function canUseNative(binding: Binding | null) {
  return !!binding?.client && !!binding.record?.declarative && !!target(binding.record);
}

/** Private, ephemeral form state. It is never registered in a view-state
 * capsule; the exact native panel lease carries it between WebViews. */
export function DeclarativeSecretDraftScope({
  client,
  record,
  children,
}: Binding & { children: ReactNode }) {
  return <Context.Provider value={{ client, record }}>{children}</Context.Provider>;
}

/** Main-document form secrets stay in module memory, outside the ordinary
 * WebView suspension snapshot. They are discarded when the panel unmounts. */
export function useMainDeclarativeSecretDraft<T>(
  key: string,
  initial: T | (() => T),
  validate: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stored = mainSecrets.get(key);
    return validate(stored)
      ? stored
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial;
  });
  useLayoutEffect(() => {
    mainSecrets.set(key, value);
    return () => {
      if (Object.is(mainSecrets.get(key), value)) mainSecrets.delete(key);
    };
  }, [key, value]);
  return [value, setValue];
}

export function useDeclarativeSecretDraft<T>(
  key: string,
  initial: T | (() => T),
  validate: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const binding = useContext(Context);
  const controller = usePanelViewController();
  const [value, setValue] = useState<T>(initial);
  const current = useRef(value);
  const initialValue = useRef(initial);
  const validateValue = useRef(validate);
  const native = canUseNative(binding);
  const captureKey = boundedKey(key);
  const targetKey = binding?.record?.staged
    ? `staged:${binding.record.key}`
    : binding?.record?.lease
      ? `owned:${binding.record.lease.windowId}:${binding.record.lease.generation}`
      : "local";
  const revision = binding?.record?.declarative?.revision ?? "";
  const requestKey = `${targetKey}:${key}:${revision}`;
  const [loadedFor, setLoadedFor] = useState<string | null>(native ? null : requestKey);
  const [failure, setFailure] = useState<{ key: string; cause: unknown } | null>(null);
  const error = failure?.key === requestKey ? failure.cause : undefined;
  const ready = !native || (loadedFor === requestKey && error === undefined);

  useEffect(() => {
    current.current = value;
  }, [value]);

  useEffect(() => {
    let alive = true;
    if (!native || !binding?.client || !binding.record || !target(binding.record)) {
      return () => {
        alive = false;
      };
    }
    void binding.client
      .declarativeViews((cause) =>
        setFailure({
          key: requestKey,
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
      )
      .readSecret(binding.record, key)
      .then(
        (stored) => {
          if (!alive) return;
          let restored: unknown = initialValue.current;
          if (stored) {
            try {
              restored = JSON.parse(stored);
            } catch {
              setFailure({ key: requestKey, cause: new Error("panel.viewState.invalid") });
              return;
            }
          }
          if (!validateValue.current(restored)) {
            setFailure({ key: requestKey, cause: new Error("panel.viewState.invalid") });
            return;
          }
          current.current = restored;
          setValue(restored);
          setLoadedFor(requestKey);
        },
        (cause: unknown) => {
          if (alive) setFailure({ key: requestKey, cause });
        },
      );
    return () => {
      alive = false;
    };
  }, [binding?.client, binding?.record, captureKey, key, native, requestKey]);

  usePanelReadiness(native ? `${captureKey}:ready` : null, ready, error);

  useLayoutEffect(() => {
    if (!controller || !native || !binding?.client || !binding.record) return;
    const record = binding.record;
    return controller.registerAsync(captureKey, async (signal) => {
      signal.throwIfAborted();
      if (!target(record)) return null;
      await binding
        .client!.declarativeViews((cause) =>
          setFailure({
            key: requestKey,
            cause: cause instanceof Error ? cause : new Error(String(cause)),
          }),
        )
        .writeSecret(record, key, JSON.stringify(current.current));
      signal.throwIfAborted();
      return null;
    });
  }, [binding?.client, binding?.record, captureKey, controller, key, native, requestKey]);

  return [value, setValue];
}
