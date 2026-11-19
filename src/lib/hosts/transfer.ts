import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Host } from "@/lib/api/types";
import type { ConnectionRoute, ProxyProfile } from "@/lib/api/network";
import type { ForwardRule, ForwardAutomation } from "@/features/forwarding/model/contract";

export interface HostDocument {
  format: "tunnelde-hosts";
  version: 1;
  platform: string;
  roots: string[];
  hosts: Array<{
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    authMethod: string;
    groupId: string | null;
    favorite: boolean;
    color: string | null;
    tags: string[];
    note: string | null;
    route: ConnectionRoute;
  }>;
  folders: Array<{ id: string; name: string; parentId: string | null }>;
  proxies: ProxyProfile[];
  forwardGroups: Array<{ id: string; hostId: string; name: string }>;
  forwards: Array<{ rule: ForwardRule; groupId: string | null; automation: ForwardAutomation }>;
  mountGroups: Array<{ id: string; hostId: string; name: string; autoReconnect: boolean }>;
  mountRules: Array<{
    id: string;
    hostId: string;
    groupId: string;
    name: string;
    remotePath: string;
    mountPoint: string;
    readOnly: boolean;
    autoMount: boolean;
  }>;
}
export interface HostImportPreview {
  revision: string;
  document: HostDocument;
  entries: Array<{
    id: string;
    name: string;
    address: string;
    conflict: boolean;
    dependency: boolean;
    requires: string[];
    forwards: number;
    mounts: number;
  }>;
}
export function hostImportSelection(
  preview: HostImportPreview,
  roots: Iterable<string>,
): Set<string> {
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of preview.entries.find((entry) => entry.id === id)?.requires ?? [])
      visit(dependency);
  };
  for (const id of roots) visit(id);
  return selected;
}
export const hostTransferApi = {
  pick: () => invoke<HostImportPreview | null>("hosts_file_import"),
  preview: (document: HostDocument) =>
    invoke<HostImportPreview>("hosts_import_preview", { document }),
  apply: (
    preview: HostImportPreview,
    selected: string[],
    copies: boolean,
    mountPoints: Record<string, string>,
  ) =>
    invoke<Host[]>("hosts_import_apply", {
      request: {
        document: preview.document,
        revision: preview.revision,
        selected,
        copies,
        mountPoints,
      },
    }),
  export: (ids: string[]) => invoke<string | null>("hosts_file_export", { ids }),
};
export const useHostTransfer = create<{
  dialog: { kind: "import" } | { kind: "export"; ids?: string[] } | null;
  openImport: () => void;
  openExport: (ids?: string[]) => void;
  close: () => void;
}>((set) => ({
  dialog: null,
  openImport: () => set({ dialog: { kind: "import" } }),
  openExport: (ids) => set({ dialog: { kind: "export", ids } }),
  close: () => set({ dialog: null }),
}));
