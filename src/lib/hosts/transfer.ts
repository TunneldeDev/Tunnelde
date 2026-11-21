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
  token?: string;
  hasCredentials?: boolean;
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
// Walk in either direction: choosing a host includes its jump hosts, while a
// conflict prevents default selection of every host that depends on it.
function reachable(roots: Iterable<string>, neighbors: (id: string) => readonly string[]) {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of neighbors(id)) pending.push(next);
  }
  return seen;
}

export function indexHostPreview(preview: HostImportPreview) {
  const entries = new Map(preview.entries.map((entry) => [entry.id, entry]));
  const dependents = new Map<string, string[]>();
  for (const entry of entries.values()) {
    for (const id of entry.requires) {
      const list = dependents.get(id);
      if (list) list.push(entry.id);
      else dependents.set(id, [entry.id]);
    }
  }
  const blocked = reachable(
    preview.entries.filter((entry) => entry.conflict).map((entry) => entry.id),
    (id) => dependents.get(id) ?? [],
  );
  return {
    preview,
    entries,
    blocked,
    expand: (roots: Iterable<string>) => reachable(roots, (id) => entries.get(id)?.requires ?? []),
  };
}
export interface LockedHostImport {
  token: string;
  locked: true;
}
interface NativeHostFile {
  token: string;
  encrypted: boolean;
  hasCredentials: boolean;
  preview: HostImportPreview | null;
}
export interface HostImportResult {
  hosts: Host[];
  credentialErrors: string[];
}
export interface HostExportOptions {
  includeCredentials: boolean;
  encrypt: boolean;
  password: string | null;
}
function fileResult(file: NativeHostFile): HostImportPreview | LockedHostImport {
  return file.preview
    ? { ...file.preview, token: file.token, hasCredentials: file.hasCredentials }
    : { token: file.token, locked: true };
}
export const hostTransferApi = {
  pick: async () => {
    const file = await invoke<NativeHostFile | null>("hosts_file_import");
    return file ? fileResult(file) : null;
  },
  unlock: async (token: string, password: string) =>
    fileResult(await invoke<NativeHostFile>("hosts_file_unlock", { token, password })),
  release: (token: string) => invoke<void>("hosts_file_release", { token }),
  generatePassword: () => invoke<string>("hosts_export_password"),
  retryCredentials: (token: string) =>
    invoke<HostImportResult>("hosts_file_retry_credentials", { token }),
  preview: async (preview: HostImportPreview) => {
    if (preview.token)
      return fileResult(
        await invoke<NativeHostFile>("hosts_file_preview", { token: preview.token }),
      ) as HostImportPreview;
    return invoke<HostImportPreview>("hosts_import_preview", { document: preview.document });
  },
  apply: async (
    preview: HostImportPreview,
    selected: string[],
    copies: boolean,
    mountPoints: Record<string, string>,
  ): Promise<HostImportResult> => {
    if (preview.token)
      return invoke<HostImportResult>("hosts_file_apply", {
        request: {
          token: preview.token,
          revision: preview.revision,
          selected,
          copies,
          mountPoints,
        },
      });
    const hosts = await invoke<Host[]>("hosts_import_apply", {
      request: {
        document: preview.document,
        revision: preview.revision,
        selected,
        copies,
        mountPoints,
      },
    });
    return { hosts, credentialErrors: [] };
  },
  export: (ids: string[], options: HostExportOptions) =>
    invoke<string | null>("hosts_file_export", { ids, options }),
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
