// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { create } from "zustand";

import type { Group, Host } from "@/lib/api/types";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export type DialogState =
  | { kind: "none" }
  | { kind: "host"; host: Host | null }
  | { kind: "group"; group: Group | null }
  | { kind: "connect"; host: Host; after: "terminal" | "sftp" }
  | ({ kind: "confirm" } & ConfirmOptions);

interface DialogStore {
  dialog: DialogState;
  openHost: (host?: Host | null) => void;
  openGroup: (group?: Group | null) => void;
  openConnect: (host: Host, after?: "terminal" | "sftp") => void;
  confirm: (options: ConfirmOptions) => void;
  close: () => void;
}

export const useDialogs = create<DialogStore>((set) => ({
  dialog: { kind: "none" },
  openHost: (host = null) => set({ dialog: { kind: "host", host } }),
  openGroup: (group = null) => set({ dialog: { kind: "group", group } }),
  openConnect: (host, after = "terminal") => set({ dialog: { kind: "connect", host, after } }),
  confirm: (options) => set({ dialog: { kind: "confirm", ...options } }),
  close: () => set({ dialog: { kind: "none" } }),
}));
