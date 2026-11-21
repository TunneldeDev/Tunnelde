import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SettingsControlState } from "../components/controlState";
import { PanelViewStateGroup, usePanelViewController } from "@/lib/panels/viewState";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import type { NativeViewProps } from "@/lib/panels/useNativeReadModel";
import { useWindowViews } from "@/lib/panels/windowViews";
import { createSettingsControlDrafts, isSettingsControlDrafts } from "./drafts";

const Context = createContext<ReturnType<typeof binding> | null>(null);
function binding(initial?: Parameters<typeof createSettingsControlDrafts>[0]) {
  const controls = createSettingsControlDrafts(initial);
  const listeners = new Set<() => void>();
  let password = "",
    ready = false,
    failure: unknown,
    disposed = false;
  let retainCount = 0;
  return {
    retain() {
      retainCount++;
      return () => {
        retainCount--;
        queueMicrotask(() => {
          if (!retainCount) {
            disposed = true;
            password = "";
            listeners.clear();
            controls.dispose();
          }
        });
      };
    },
    controls,
    secrets: {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      read: () => password,
      write(value: string) {
        if (disposed) return;
        password = value;
        for (const listener of listeners) listener();
      },
    },
    state: () => ({ ready, failure }),
    loaded(value: string) {
      if (disposed) return;
      password = value;
      ready = true;
    },
    fail(error: unknown) {
      if (!disposed) failure = error;
    },
    dispose() {
      disposed = true;
      password = "";
      listeners.clear();
      controls.dispose();
    },
  };
}
function BoundDrafts({
  client,
  record,
  children,
}: Pick<NativeViewProps, "client" | "record"> & { children: ReactNode }) {
  const controller = usePanelViewController();
  const [drafts] = useState(() => binding(controller?.read("controls", isSettingsControlDrafts)));
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState<unknown>();
  usePanelReadiness("draftsReady", loaded, error);
  useEffect(() => {
    let alive = true;
    const target = record.staged
      ? { kind: "staged" as const, id: record.key }
      : record.lease
        ? { kind: "owned" as const, lease: record.lease }
        : null;
    if (!target) return;
    void client.control<string>({ action: "readSettingsPassword", target }).then(
      (value) => {
        if (alive) {
          drafts.loaded(value);
          setLoaded(true);
        }
      },
      (error) => {
        if (alive) {
          drafts.fail(error);
          setError(error);
        }
      },
    );
    return () => {
      alive = false;
    };
    // Promotion preserves this tree and its already-restored private draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, record.key, drafts]);
  useLayoutEffect(() => {
    if (!controller) return;
    const stop = drafts.controls.subscribe(controller.changed);
    const unregister = controller.register(
      "controls",
      () => {
        if (!drafts.state().ready) throw new Error("panel.window.viewNotReady");
        return drafts.controls.capture();
      },
      async (signal) => {
        signal.throwIfAborted();
        const current = useWindowViews.getState().entries.get(record.panelId);
        if (
          !current?.lease ||
          current.staged ||
          current.key !== record.key ||
          current.controller !== record.controller ||
          current.failed
        )
          throw new Error("panel.window.staleOwner");
        // Keep credentials out of this capsule; flush privately BEFORE prepare.
        await client.control({
          action: "writeSettingsPassword",
          lease: current.lease,
          value: drafts.secrets.read(),
        });
        signal.throwIfAborted();
        return drafts.controls.capture();
      },
    );
    return () => {
      stop();
      unregister();
    };
  }, [client, controller, drafts, record.key, record.panelId, record.controller]);
  useEffect(() => drafts.retain(), [drafts]);
  return (
    <Context.Provider value={drafts}>
      {loaded ? children : <div role="status" aria-busy="true" />}
    </Context.Provider>
  );
}
export function SettingsDraftScope(
  props: Pick<NativeViewProps, "client" | "record"> & { children: ReactNode },
) {
  return (
    <PanelViewStateGroup name="settings">
      <BoundDrafts {...props} />
    </PanelViewStateGroup>
  );
}
/** This hook itself is injected; rendering code never imports native IPC. */
export const useSettingsControlState: SettingsControlState = <T,>(key: string, initial: T) => {
  const state = useContext(Context);
  if (!state) throw new Error("panel.window.staleOwner");
  const [identity] = useState(() => ({ state, key, fallback: initial }));
  if (identity.state !== state || identity.key !== key || key === "network:password")
    throw new Error("panel.viewState.identityChanged");
  const value = useSyncExternalStore(state.controls.subscribe, () =>
    state.controls.read(key, identity.fallback),
  );
  const set = useCallback<ReturnType<SettingsControlState>[1]>(
    (next) => {
      const previous = state.controls.read(key, identity.fallback);
      state.controls.write(
        key,
        typeof next === "function" ? (next as (value: T) => T)(previous) : next,
      );
    },
    [state, key, identity],
  );
  return [value, set];
};
export const useSettingsSecretState: SettingsControlState = <T,>(key: string, initial: T) => {
  const state = useContext(Context),
    controller = usePanelViewController();
  if (!state || key !== "network:password" || typeof initial !== "string")
    throw new Error("panel.viewState.invalidKey");
  const value = useSyncExternalStore(state.secrets.subscribe, state.secrets.read);
  const set = useCallback<ReturnType<SettingsControlState>[1]>(
    (next) => {
      const value =
        typeof next === "function"
          ? (next as (value: string) => unknown)(state.secrets.read())
          : next;
      if (typeof value !== "string" || new TextEncoder().encode(value).length > 8192)
        throw new Error("panel.viewState.tooLarge");
      state.secrets.write(value);
      controller?.changed();
    },
    [state, controller],
  );
  return [value as T, set];
};
export function useSettingsBusyGuard(busy: boolean) {
  const id = useId();
  // Nested group lifts the root field-count limit without relaxing JSON bounds.
  usePanelReadiness(`busy:${id}`, !busy);
}

export function useSettingsPrivatePassword() {
  const state = useContext(Context);
  if (!state) throw new Error("panel.window.staleOwner");
  return state.secrets.read;
}
export function useSettingsControlRegistry() {
  const binding = useContext(Context);
  if (!binding) throw new Error("panel.window.staleOwner");
  return binding.controls;
}
