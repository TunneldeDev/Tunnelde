import { habitStorage } from "@/lib/habits/storage";
import { panelPresentation } from "./panelPresentation";
import { closePanel, setPanelLocation } from "@/lib/panels/controller";
import { create } from "zustand";
import { captureFileTarget } from "@/lib/files/resources/target";
import type { FsSource } from "@/lib/api/types";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { usePanelWindows } from "@/store/panelWindows";

export type PreviewPresentation = "quickLook" | "docked";
const presentationKey = "tunnelde.filePreview.presentation";
export const previewPanelId = "sidebar:filePreview";

function preferredPresentation(): PreviewPresentation {
  try {
    return habitStorage.getItem(presentationKey) === "docked" ? "docked" : "quickLook";
  } catch {
    return "quickLook";
  }
}

export function previewPanelOpen(): boolean {
  const tab = useWorkspace.getState().tabs.find((item) => item.id === previewPanelId);
  const navigation = useNavigation.getState();
  if (panelPresentation("filePreview").getState().open) return true;
  return tab
    ? !tab.hidden
    : navigation.sidebarVisible && navigation.activeSidebar === "filePreview";
}

function openPanel() {
  const workspace = useWorkspace.getState();
  if (panelPresentation("filePreview").getState().preferred === "floating") {
    setPanelLocation("filePreview", "floating");
    return;
  }
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
  closePanel("filePreview");
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

export interface PreviewBrowserContext {
  id: string;
  paths: string[];
}

export const useFilePreview = create<{
  file: PreviewFile | null;
  id: string | null;
  browser: PreviewBrowserContext | null;
  navigate: (direction: -1 | 1) => void;
  browse: (
    path: string,
    source: FsSource,
    browser: PreviewBrowserContext,
    follow?: boolean,
  ) => void;
  presentation: PreviewPresentation;
  show: (path: string, line?: number, column?: number, source?: FsSource) => void;
  dock: () => void;
  undock: () => void;
  close: () => void;
}>((set, get) => ({
  file: null,
  id: null,
  browser: null,
  browse: (path, source, browser, follow = false) => {
    const current = get();
    const native = usePanelWindows.getState();
    const nativeOpen =
      native.available &&
      native.snapshot.panels.some(
        (panel) => panel.panelId === "filePreview" && panel.windowId !== "main",
      );
    if (
      follow &&
      (!current.file ||
        current.browser?.id !== browser.id ||
        current.file.source.kind !== source.kind ||
        (current.file.source.kind === "remote" &&
          source.kind === "remote" &&
          current.file.source.sessionId !== source.sessionId) ||
        current.presentation !== "docked" ||
        (!previewPanelOpen() && !nativeOpen))
    )
      return;
    if (follow && current.file?.path === path) return;
    if (follow)
      set({
        id: crypto.randomUUID(),
        file: { ...captureFileTarget(path, source), line: 0, column: 0 },
      });
    else get().show(path, 0, 0, source);
    set({ browser: { id: browser.id, paths: [...new Set(browser.paths)] } });
  },
  navigate: (direction) => {
    const { file, browser } = get();
    if (!file || !browser) return;
    const index = browser.paths.indexOf(file.path);
    const path = index < 0 ? undefined : browser.paths[index + direction];
    // Navigation changes the target in the current surface, including native windows.
    if (path)
      set({
        id: crypto.randomUUID(),
        file: { ...captureFileTarget(path, file.source), line: 0, column: 0 },
      });
  },
  presentation: preferredPresentation(),
  show: (path, line = 0, column = 0, source = { kind: "local" }) => {
    const target = captureFileTarget(path, source);
    if (get().presentation === "docked") openPanel();
    set({
      browser: null,
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
      habitStorage.setItem(presentationKey, "docked");
    } catch {
      /* The live presentation does not require browser storage. */
    }
    set({ presentation: "docked" });
  },
  undock: () => {
    set({ presentation: "quickLook" });
    try {
      habitStorage.setItem(presentationKey, "quickLook");
    } catch {
      /* The live presentation does not require browser storage. */
    }
    hidePanel();
  },
  close: () => {
    set({ file: null, id: null, browser: null });
    hidePanel();
  },
}));
