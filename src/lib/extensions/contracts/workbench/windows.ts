/** Experimental metadata DTOs; separate from frozen workspace.snapshot v1.
 * IDs/generations are stale-owner markers, not native IPC credentials.
 */
export interface NativeWorkspaceWindow {
  id: string;
  role: "coordinator" | "satellite";
  ready: boolean;
  closing: boolean;
  panelIds: string[];
}
export interface NativePanelOwnership {
  panelId: string;
  windowId: string;
  generation: number;
  transferable: boolean;
  /** Advisory. All actions reauthorize current native state. */
  canMove: boolean;
}
export interface NativeWorkspaceSnapshot {
  revision: string;
  windowId: "main";
  windows: NativeWorkspaceWindow[];
  panels: NativePanelOwnership[];
}
export interface NativeWorkspaceObservation {
  revision?: string;
}
export interface NativeWindowCloseRequest {
  windowId: string;
}
export interface NativeWindowCloseResult {
  windowId: string;
  /** Acceptance only; observe metadata to learn the eventual outcome. */
  requested: true;
}
