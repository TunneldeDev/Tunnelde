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

/** The target must already exist and be ready. Use windows.create separately. */
export interface NativePanelMoveRequest {
  panelId: string;
  windowId: string;
  expectedOwner?: { windowId: string; generation: number };
}
/** Returned only after destination readiness and native handoff commit. */
export interface NativePanelMoveResult {
  panelId: string;
  windowId: string;
  generation: number;
}

/** Authoritative source-window presentation metadata, separate from workspace v1. */
export interface WorkspacePanelMetadata {
  id: string;
  windowId: string;
  presentation: "sidebar" | "workspace" | "floating";
  visible: boolean;
  pinned: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  available: boolean;
  /** Inspect this window's supported forms before requesting a change. */
  presentations: readonly ("sidebar" | "workspace" | "floating")[];
}
export interface WorkspacePanelsSnapshot {
  revision: string;
  windowId: "main";
  panels: WorkspacePanelMetadata[];
}
export interface WorkspacePanelPresentationRequest {
  panelId: string;
  presentation: "sidebar" | "workspace" | "floating";
}
export interface WorkspacePanelCloseRequest {
  panelId: string;
}
