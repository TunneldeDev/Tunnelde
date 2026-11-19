import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { KnownHostEntry } from "@/lib/api/types";
import {
  createKnownHostsSource,
  useKnownHostsSource,
  type KnownHostsData,
} from "@/features/settings/knownHosts/source";
import { usePanelLeaseAction } from "./interaction";
export interface KnownHostsPanelModel extends KnownHostsData {
  refresh: () => Promise<unknown>;
  forget: (entry: KnownHostEntry) => Promise<unknown>;
}
const Context = createContext<KnownHostsPanelModel | null>(null);
export function KnownHostsModelScope({
  value,
  children,
}: {
  value: KnownHostsPanelModel;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useKnownHostsModel(active: boolean): KnownHostsPanelModel {
  const remote = useContext(Context);
  const shared = useKnownHostsSource((s) => s.source);
  const [local] = useState(createKnownHostsSource);
  const source = shared ?? local;
  const data = useStore(source.store);
  const action = usePanelLeaseAction();
  useEffect(() => (active && !remote ? source.retain() : undefined), [source, active, remote]);
  return (
    remote ?? {
      ...data,
      refresh: () => action({ kind: "refreshKnownHosts" }) ?? source.refresh(),
      forget: (entry) => action({ kind: "forgetKnownHost", entry }) ?? source.forget(entry),
    }
  );
}
