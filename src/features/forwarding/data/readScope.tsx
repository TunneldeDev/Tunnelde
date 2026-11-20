import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { ForwardingReadData } from "./readModel";

const Context = createContext<ForwardingReadData | null>(null);
export function ForwardingReadScope({
  value,
  children,
}: {
  value: ForwardingReadData;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useForwardingReadModel() {
  const data = useContext(Context);
  if (!data && usePanelWindows.getState().windowId !== "main")
    throw new Error("panel.window.unsupportedView");
  return data;
}
export const ignoreForwardingSubscription = () => () => {};

const currentSessions = () => useSsh.getState().sessions;
export function useForwardingSessions(): ForwardingReadData["sessions"] {
  const remote = useForwardingReadModel()?.sessions;
  return useSyncExternalStore(
    remote ? ignoreForwardingSubscription : useSsh.subscribe,
    remote ? () => remote : currentSessions,
  );
}
