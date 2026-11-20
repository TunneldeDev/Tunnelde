import { usePanelWindows } from "@/store/panelWindows";
import { createContext, useContext, type ReactNode } from "react";
import { localForwardingActions, type ForwardingActions } from "./actions";

const Context = createContext<ForwardingActions | null>(null);
/** A remote presentation supplies every operation; never fall through to raw
 * main IPC when a scoped operation fails, expires or rejects provider authority. */
export function ForwardingActionScope({
  value,
  children,
}: {
  value: ForwardingActions;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useForwardingActions(): ForwardingActions {
  const actions = useContext(Context);
  if (!actions && usePanelWindows.getState().windowId !== "main")
    throw new Error("panel.window.unsupportedView");
  return actions ?? localForwardingActions;
}
