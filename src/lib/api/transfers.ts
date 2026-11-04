import { invoke } from "@tauri-apps/api/core";
import type { TransferEvent } from "./types";
export interface DurableTransfer extends Omit<TransferEvent, "status"> {
  status: TransferEvent["status"] | "paused";
  updatedAt: number;
  fromHostId: string | null;
  toHostId: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  fromPath?: string;
  toPath?: string;
}
export const transferApi = {
  list: () => invoke<DurableTransfer[]>("durable_transfer_list"),
  pause: (id: string) => invoke<void>("durable_transfer_pause", { id }),
  resume: (id: string) => invoke<void>("durable_transfer_resume", { id }),
  clear: (id: string) => invoke<DurableTransfer | null>("durable_transfer_clear", { id }),
  setSpeedLimit: (id: string, kib: number) => invoke<void>("transfer_set_speed_limit", { id, kib }),
};
