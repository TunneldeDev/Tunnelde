import { createContext, useContext, type ReactNode } from "react";
import type { LocalPanelWorkspace } from "./localWorkspace";
import type { PanelPresentation } from "@/store/panelPresentation";
import type { StoreApi } from "zustand";
import type { FloatingPanelState } from "@/store/panelPresentation";
export interface LocalPanelScope {
  workspace: LocalPanelWorkspace;
  panelId: string;
  location: PanelPresentation;
  visible: boolean;
  floating: StoreApi<FloatingPanelState>;
}
const Context = createContext<LocalPanelScope | null>(null);
export const useLocalPanelScope = () => useContext(Context);
export function LocalPanelScopeProvider({
  value,
  children,
}: {
  value: LocalPanelScope;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
