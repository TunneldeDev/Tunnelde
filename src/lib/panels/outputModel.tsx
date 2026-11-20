import { createContext, useContext, type ReactNode } from "react";
import type { AppInfo, PluginInfo } from "@/lib/api/types";
import type { OutputEntry } from "@/features/output/model";
export type OutputRuntimeInfo = Pick<
  AppInfo,
  "name" | "version" | "os" | "arch" | "tauriVersion" | "debug"
>;
export type OutputPluginInfo = Pick<PluginInfo, "id" | "name" | "version" | "status" | "error">;
export interface OutputPanelData {
  entries: OutputEntry[];
  truncated: boolean;
  error: string;
  info: OutputRuntimeInfo | null;
  plugins: OutputPluginInfo[];
  sessionCount: number;
}
export interface OutputPanelModel extends OutputPanelData {
  refresh: () => Promise<unknown>;
  clear: () => void | Promise<unknown>;
  copy: (text: string) => Promise<unknown>;
  openLatest: () => Promise<unknown>;
  openDirectory: () => Promise<unknown>;
}
const Context = createContext<OutputPanelModel | null>(null);
export const useRemoteOutputModel = () => useContext(Context);
export function OutputModelScope({
  value,
  children,
}: {
  value: OutputPanelModel;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
