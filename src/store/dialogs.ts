import { create } from "zustand";

import type { Group, Host } from "@/lib/api/types";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  preformatted?: boolean;
  onConfirm: () => void | Promise<void>;
}

export type DialogState =
  | { kind: "none" }
  | { kind: "host"; host: Host | null; groupId?: string | null }
  | { kind: "group"; group: Group | null }
  | {
      kind: "connect";
      host: Host;
      after: "terminal" | "sftp" | "background";
      intent: "connect" | "installKey";
      error?: string;
    }
  | ({ kind: "confirm" } & ConfirmOptions);

interface DialogStore {
  dialog: DialogState;
  openHost: (host?: Host | null, groupId?: string | null) => void;
  openGroup: (group?: Group | null) => void;
  openConnect: (
    host: Host,
    after?: "terminal" | "sftp" | "background",
    intent?: "connect" | "installKey",
    error?: string,
  ) => void;
  confirm: (options: ConfirmOptions) => void;
  close: () => void;
}

export const useDialogs = create<DialogStore>((set) => ({
  dialog: { kind: "none" },
  openHost: (host = null, groupId = null) => set({ dialog: { kind: "host", host, groupId } }),
  openGroup: (group = null) => set({ dialog: { kind: "group", group } }),
  openConnect: (host, after = "terminal", intent = "connect", error) =>
    set({ dialog: { kind: "connect", host, after, intent, error } }),
  confirm: (options) => set({ dialog: { kind: "confirm", ...options } }),
  close: () => set({ dialog: { kind: "none" } }),
}));
