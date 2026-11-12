import { create } from "zustand";
import { captureFileTarget } from "@/lib/files/resources/target";
import type { FsSource } from "@/lib/api/types";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";

export type PreviewPresentation = "quickLook" | "docked";
const presentationKey = "tunnelde.filePreview.presentation";
export const previewPanelId = "sidebar:filePreview";

function preferredPresentation(): PreviewPresentation {
  try {
    return localStorage.getItem(presentationKey) === "docked" ? "docked" : "quickLook";
  } catch {
    return "quickLook";
  }
}

export function previewPanelOpen(): boolean {
  const tab = useWorkspace.getState().tabs.find((item) => item.id === previewPanelId);
  const navigation = useNavigation.getState();
  return tab
    ? !tab.hidden
    : navigation.sidebarVisible && navigation.activeSidebar === "filePreview";
}

function openPanel() {
  const workspace = useWorkspace.getState();
  if (workspace.tabs.some((tab) => tab.id === previewPanelId)) {
    workspace.activate(previewPanelId);
  } else {
    const navigation = useNavigation.getState();
    if (navigation.activeSidebar === "filePreview" && navigation.sidebarVisible) return;
    workspace.ensureWelcome();
    workspace.splitTab(previewPanelId, "row", "after", "root");
    const layout = useWorkspace.getState().layout;
    if (layout.kind === "split") useWorkspace.getState().resizeSplit(layout.id, 0.65);
  }
}

function hidePanel() {
  useWorkspace.getState().close(previewPanelId);
  const navigation = useNavigation.getState();
  if (
    navigation.sidebarVisible &&
    navigation.activeSidebar === "filePreview" &&
    !useWorkspace.getState().tabs.some((tab) => tab.id === previewPanelId)
  )
    useNavigation.setState({ sidebarVisible: false });
}

export interface PreviewFile {
  path: string;
  line: number;
  column: number;
  source: FsSource;
}

export const useFilePreview = create<{
  file: PreviewFile | null;
  id: string | null;
  presentation: PreviewPresentation;
  show: (path: string, line?: number, column?: number, source?: FsSource) => void;
  dock: () => void;
  undock: () => void;
  close: () => void;
}>((set, get) => ({
  file: null,
  id: null,
  presentation: preferredPresentation(),
  show: (path, line = 0, column = 0, source = { kind: "local" }) => {
    const target = captureFileTarget(path, source);
    if (get().presentation === "docked") openPanel();
    set({
      id: crypto.randomUUID(),
      file: {
        ...target,
        line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
        column: Number.isSafeInteger(column) && column >= 0 ? column : 0,
      },
    });
  },
  dock: () => {
    openPanel();
    try {
      localStorage.setItem(presentationKey, "docked");
    } catch {
      /* The live presentation does not require browser storage. */
    }
    set({ presentation: "docked" });
  },
  undock: () => {
    set({ presentation: "quickLook" });
    try {
      localStorage.setItem(presentationKey, "quickLook");
    } catch {
      /* The live presentation does not require browser storage. */
    }
    hidePanel();
  },
  close: () => {
    set({ file: null, id: null });
    hidePanel();
  },
}));
