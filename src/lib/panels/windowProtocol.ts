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
  windows: NativePanelWindow[];
  panels: PanelLease[];
  transfers: Array<{ offer: PanelTransferOffer; ready: boolean }>;
}
export type PanelWindowCommand =
  | { action: "snapshot" | "ready" | "beginClose" | "cancelClose" }
  | { action: "addPanel" | "removePanel"; panelId: string }
  | { action: "authorize" | "view" | "issueDrag"; lease: PanelLease }
  | { action: "checkpoint"; lease: PanelLease; revision: number; state: unknown }
  | { action: "prepare"; lease: PanelLease; targetWindow: string; state: unknown }
  | { action: "staged" | "acknowledge" | "commit" | "cancel"; id: string }
  | { action: "block"; panelId: string; blocked: boolean }
  | { action: "acceptDrag"; token: string };
export interface NativePanelIdentity {
  windowId: string;
  document: string;
}
