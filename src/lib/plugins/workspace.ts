// BEGIN GENERATED WORKSPACE V1 TYPES
/** Wire DTOs for the v1 workspace snapshot, independent of workbench stores. */
export interface PluginFileViewPreferences {
  filesColumns?: string[];
  filesColumnWidths?: Partial<Record<"name" | "type" | "size" | "modified", number>>;
  filesLayout?: string;
  filesShowHidden: boolean;
  filesFoldersFirst: boolean;
  filesSortBy: string;
  filesSortDirection: string;
  filesGroupBy?: string;
}

export interface PluginFilePane {
  source: { kind: "local" } | { kind: "remote"; sessionId: string };
  path: string | null;
  ownerSessionId: string;
  view?: PluginFileViewPreferences;
  remoteIdentity?: { hostId: string; address: string };
  offline?: boolean;
}

export interface PluginWorkspaceTab {
  id: string;
  /** Open vocabulary: plugins must tolerate tab kinds they do not recognize. */
  kind: string;
  title: string;
  hostId: string | null;
  pinned: boolean;
  preview?: boolean;
  hidden?: boolean;
  filePane?: PluginFilePane;
  fileSessionId?: string | null;
}

export interface PluginWorkspacePane {
  id: string;
  tabIds: string[];
  activeId: string | null;
  locked?: boolean;
}

export type PluginWorkspaceLayout =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      id: string;
      direction: "row" | "column";
      ratio: number;
      first: PluginWorkspaceLayout;
      second: PluginWorkspaceLayout;
    };

export interface PluginWorkspaceSnapshot {
  tabs: PluginWorkspaceTab[];
  panes: PluginWorkspacePane[];
  activeId: string | null;
  activePaneId: string;
  layout: PluginWorkspaceLayout;
}
// END GENERATED WORKSPACE V1 TYPES

function fileView(view: PluginFileViewPreferences): PluginFileViewPreferences {
  const widths = view.filesColumnWidths;
  return {
    ...(view.filesColumns === undefined ? {} : { filesColumns: [...view.filesColumns] }),
    ...(widths === undefined
      ? {}
      : {
          filesColumnWidths: {
            ...(widths.name === undefined ? {} : { name: widths.name }),
            ...(widths.type === undefined ? {} : { type: widths.type }),
            ...(widths.size === undefined ? {} : { size: widths.size }),
            ...(widths.modified === undefined ? {} : { modified: widths.modified }),
          },
        }),
    ...(view.filesLayout === undefined ? {} : { filesLayout: view.filesLayout }),
    filesShowHidden: view.filesShowHidden,
    filesFoldersFirst: view.filesFoldersFirst,
    filesSortBy: view.filesSortBy,
    filesSortDirection: view.filesSortDirection,
    ...(view.filesGroupBy === undefined ? {} : { filesGroupBy: view.filesGroupBy }),
  };
}

function filePane(pane: PluginFilePane): PluginFilePane {
  return {
    source:
      pane.source.kind === "remote"
        ? { kind: "remote", sessionId: pane.source.sessionId }
        : { kind: "local" },
    path: pane.path,
    ownerSessionId: pane.ownerSessionId,
    ...(pane.view === undefined ? {} : { view: fileView(pane.view) }),
    ...(pane.remoteIdentity === undefined
      ? {}
      : {
          remoteIdentity: {
            hostId: pane.remoteIdentity.hostId,
            address: pane.remoteIdentity.address,
          },
        }),
    ...(pane.offline === undefined ? {} : { offline: pane.offline }),
  };
}

function layout(node: PluginWorkspaceLayout): PluginWorkspaceLayout {
  return node.kind === "pane"
    ? { kind: "pane", paneId: node.paneId }
    : {
        kind: "split",
        id: node.id,
        direction: node.direction,
        ratio: node.ratio,
        first: layout(node.first),
        second: layout(node.second),
      };
}

/** Copy every documented field; never forward future internal state or references. */
export function projectPluginWorkspace(value: PluginWorkspaceSnapshot): PluginWorkspaceSnapshot {
  return {
    tabs: value.tabs.map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      hostId: tab.hostId,
      pinned: tab.pinned,
      ...(tab.preview === undefined ? {} : { preview: tab.preview }),
      ...(tab.hidden === undefined ? {} : { hidden: tab.hidden }),
      ...(tab.filePane === undefined ? {} : { filePane: filePane(tab.filePane) }),
      ...(tab.fileSessionId === undefined ? {} : { fileSessionId: tab.fileSessionId }),
    })),
    panes: value.panes.map((pane) => ({
      id: pane.id,
      tabIds: [...pane.tabIds],
      activeId: pane.activeId,
      ...(pane.locked === undefined ? {} : { locked: pane.locked }),
    })),
    activeId: value.activeId,
    activePaneId: value.activePaneId,
    layout: layout(value.layout),
  };
}
