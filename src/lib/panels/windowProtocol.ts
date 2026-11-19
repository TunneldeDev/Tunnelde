import type { TransferWindowAction } from "@/features/sftp/transferWindowProtocol";
import type { KnownHostEntry } from "@/lib/api/types";
/** This is the private native UI transport, not the public plugin API. Caller
 * window identity is derived by the host and never accepted as a JS argument. */
export interface PanelLease {
  panelId: string;
  windowId: string;
  generation: number;
}
export interface NativePanelWindow {
  id: string;
  ready: boolean;
  closing: boolean;
}
export interface PanelTransferOffer {
  id: string;
  lease: PanelLease;
  targetWindow: string;
}
export interface NativePanelSnapshot {
  /** Unknown effects after coordinator document loss; counts only, no requests. */
  interruptions?: ReadonlyArray<{ panelId: string; count: number }>;
  windows: NativePanelWindow[];
  panels: PanelLease[];
  transfers: Array<{ offer: PanelTransferOffer; ready: boolean }>;
}
export type PanelViewAction =
  | TransferWindowAction
  | { kind: "task"; key: string; ticket: string; actionId: string }
  | { kind: "clearTasks" }
  | { kind: "disconnect"; sessionId: string }
  | { kind: "output"; operation: "refresh" | "clear" | "openLatest" | "openDirectory" }
  | { kind: "copyOutput"; text: string }
  | { kind: "refreshKnownHosts" }
  | { kind: "forgetKnownHost"; entry: KnownHostEntry };
export type PanelActionResult =
  { status: "done"; value: unknown } | { status: "failed"; message: string };
export interface PanelActionJob {
  id: string;
  lease: PanelLease;
  request: PanelViewAction;
}
export type PanelWindowCommand =
  | { action: "requestAction"; lease: PanelLease; request: PanelViewAction }
  | { action: "claimActions" }
  | { action: "completeAction"; id: string; result: PanelActionResult }
  | { action: "actionResult" | "cancelAction"; id: string }
  | { action: "snapshot" | "ready" | "beginClose" | "cancelClose" }
  | { action: "addPanel" | "removePanel"; panelId: string }
  | { action: "authorize" | "view" | "readModel" | "issueDrag"; lease: PanelLease }
  | { action: "beginModel"; panelId: string }
  | { action: "publishModel"; publisher: string; panelId: string; revision: number; model: unknown }
  | { action: "checkpoint"; lease: PanelLease; revision: number; state: unknown }
  | { action: "prepare"; lease: PanelLease; targetWindow: string; state: unknown }
  | { action: "staged" | "stagedModel" | "acknowledge" | "commit" | "cancel"; id: string }
  | { action: "beginInteraction"; lease: PanelLease }
  | { action: "endInteraction"; lease: PanelLease; id: string }
  | { action: "block"; panelId: string; blocked: boolean }
  | { action: "acceptDrag" | "cancelDrag"; token: string };
export interface NativePanelIdentity {
  windowId: string;
  document: string;
}

export interface NativePanelDragRelease {
  lease: PanelLease;
  /** null means outside every visible application window, not a failed query. */
  targetWindow: string | null;
}
