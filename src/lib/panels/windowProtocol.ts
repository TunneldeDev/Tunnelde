import type { SettingsWindowCommand } from "@/features/settings/window/protocol";
import type { EditorWindowCommand } from "@/features/editor/editorWindowModel";
import type { HostDetailCommand } from "@/features/hosts/detail/protocol";
import type { FileWindowCommand } from "@/features/sftp/fileWindowModel";
import type { TerminalWindowCommand } from "@/features/terminal/terminalWindowModel";
import type { PluginListCommand } from "@/features/plugins/panel/model";
import type { HostPanelWindowAction } from "@/features/hosts/panel/protocol";
import type { PreviewWindowAction } from "@/features/sftp/preview/windowActions";
import type { PanelPresentation } from "@/store/panelPresentation";
import type { FloatingRect } from "@/lib/layout/floatingPanel";
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
/** Whitelisted display identity, never activation credentials or grants. A
 * factoryless declarative view has no module entry or SDK identity. */
export interface NativePluginViewDescriptor {
  panelId: string;
  /** Stale-approval marker, not a bearer credential. */
  revision: string;
  pluginId: string;
  generation: number;
  runtimeId: string;
  viewId: string;
  entry: string;
  sdkVersion: string;
  title: string;
  allowFloating: boolean;
  renderer?: "frontend" | "json";
}
/** Host-rendered JSON view identity. This is not a frontend module and never
 * carries activation credentials, permissions, entry points or an SDK. */
export interface NativeDeclarativeViewDescriptor {
  panelId: string;
  revision: string;
  pluginId: string;
  runtimeId: string;
  generation: number;
  viewId: string;
  title: string;
  allowFloating: boolean;
  renderer: "json";
}
/** Selected forwarding module identity; no activation token or write grant. */
export interface NativeForwardingProviderDescriptor {
  selectionRevision: number;
  /** Display hint from current grants, never caller-supplied write authority. */
  capabilities: { write: boolean };
  view: Omit<NativePluginViewDescriptor, "panelId" | "revision">;
}
export interface NativePreviewProviderDescriptor extends NativeForwardingProviderDescriptor {
  sourceKind: "local" | "remote";
}
export interface NativePanelSnapshot {
  settingsPages?: Array<{ panelId: string; allowMove: boolean }>;
  hostPages?: Array<{ panelId: string; allowMove: boolean }>;
  editorPages?: Array<{ panelId: string }>;
  filePages?: Array<{ panelId: string; allowMove: boolean }>;
  terminalViews?: Array<{ panelId: string; allowMove: boolean }>;
  pluginViews?: NativePluginViewDescriptor[];
  declarativeViews?: NativeDeclarativeViewDescriptor[];
  /** Unknown effects after coordinator document loss; counts only, no requests. */
  interruptions?: ReadonlyArray<{ panelId: string; count: number }>;
  windows: NativePanelWindow[];
  panels: PanelLease[];
  transfers: Array<{ offer: PanelTransferOffer; ready: boolean }>;
}
export type PanelViewAction =
  | { kind: "settings"; command: SettingsWindowCommand }
  | { kind: "hostDetail"; command: HostDetailCommand }
  | { kind: "editor"; command: EditorWindowCommand }
  | { kind: "files"; command: FileWindowCommand }
  | {
      kind: "terminal";
      command: TerminalWindowCommand;
    }
  | { kind: "plugins"; command: PluginListCommand }
  | HostPanelWindowAction
  | PreviewWindowAction
  | TransferWindowAction
  | { kind: "task"; key: string; ticket: string; actionId: string }
  | { kind: "clearTasks" }
  | { kind: "disconnect"; sessionId: string }
  | { kind: "output"; operation: "refresh" | "clear" | "openLatest" | "openDirectory" }
  | { kind: "copyOutput"; text: string }
  | { kind: "refreshKnownHosts" }
  | { kind: "refreshForwarding" }
  | { kind: "forgetKnownHost"; entry: KnownHostEntry };
export type PanelActionResult =
  { status: "done"; value: unknown } | { status: "failed"; message: string };
export interface PanelActionJob {
  id: string;
  lease: PanelLease;
  request: PanelViewAction;
}
export interface PanelMoveJob {
  id: string;
  lease: PanelLease;
  targetWindow: string;
}
export interface PanelLayoutMetadata {
  presentation: PanelPresentation;
  visible: boolean;
  pinned: boolean;
  bounds: FloatingRect | null;
  available: boolean;
  presentations: readonly PanelPresentation[];
}
export interface PanelPresentationJob {
  id: string;
  lease: PanelLease;
  operation: { kind: "set"; presentation: PanelPresentation } | { kind: "close" };
}
export type PanelWindowCommand =
  | { action: "requestCoordinatorPreviewAction"; lease: PanelLease; request: PreviewWindowAction }
  | { action: "publishPreviewResource"; resource: { id: string; ticket: string } | null }
  | {
      action: "openPreviewHandle";
      target: { kind: "owned"; lease: PanelLease } | { kind: "staged"; id: string };
      resourceId: string;
    }
  | { action: "closePreviewHandle"; id: string }
  | { action: "beginPluginModel"; panelId: string; revision: string }
  | { action: "publishPresentation"; lease: PanelLease; metadata: PanelLayoutMetadata }
  | {
      action: "publishStagedPresentation" | "completePresentation";
      id: string;
      metadata: PanelLayoutMetadata;
    }
  | { action: "publishUnavailablePreview"; metadata: PanelLayoutMetadata }
  | { action: "claimPresentations" }
  | { action: "beginPresentation" | "failPresentation"; id: string }
  | { action: "requestAction"; lease: PanelLease; request: PanelViewAction }
  | { action: "claimActions" | "claimPanelMoves" }
  | { action: "preparePanelMove"; id: string; state: unknown }
  | { action: "failPanelMove"; id: string }
  | { action: "completeAction"; id: string; result: PanelActionResult }
  | { action: "actionResult" | "cancelAction"; id: string }
  | { action: "readSettingsPasswordForOwner"; lease: PanelLease }
  | { action: "bindSettingsPage"; panelId: string; allowMove: boolean }
  | { action: "writeSettingsPassword"; lease: PanelLease; value: string }
  | {
      action: "readSettingsPassword";
      target: { kind: "owned"; lease: PanelLease } | { kind: "staged"; id: string };
    }
  | { action: "bindEditorPage"; panelId: string }
  | { action: "bindHostPage"; panelId: string; hostId: string; allowMove: boolean }
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
  | { action: "acceptDrag" | "cancelDrag" | "renewDrag"; token: string };
export interface NativePanelIdentity {
  windowId: string;
  document: string;
}

export interface NativePanelDragRelease {
  lease: PanelLease;
  /** null means outside every visible application window, not a failed query. */
  targetWindow: string | null;
}
