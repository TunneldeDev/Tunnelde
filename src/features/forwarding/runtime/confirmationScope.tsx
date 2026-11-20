import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { useDialogs, type ConfirmOptions } from "@/store/dialogs";
import { usePanelWindows } from "@/store/panelWindows";

/** Internal UI service only. An original interaction is not a provider origin
 * or a reusable approval. Never serialize this service or its continuation. */
export type ForwardingConfirmation = Omit<ConfirmOptions, "onConfirm"> & {
  onConfirm: (interaction?: string) => void | Promise<unknown>;
};
export type ForwardingConfirm = (options: ForwardingConfirmation) => void;
const Context = createContext<ForwardingConfirm | null>(null);
const ignore = () => () => {};
const noConfirm = () => null;
const mainConfirm = () => useDialogs.getState().confirm;
export function ForwardingConfirmationScope({
  value,
  children,
}: {
  value: ForwardingConfirm;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useForwardingConfirm(): ForwardingConfirm {
  const scoped = useContext(Context);
  const confirm = useSyncExternalStore(
    scoped ? ignore : useDialogs.subscribe,
    scoped ? noConfirm : mainConfirm,
  );
  if (!scoped && usePanelWindows.getState().windowId !== "main")
    throw new Error("panel.window.unsupportedView");
  return (
    scoped ??
    ((options) =>
      confirm!({
        ...options,
        onConfirm: async () => {
          await options.onConfirm();
        },
      }))
  );
}
