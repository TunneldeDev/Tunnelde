import type { FilePaneOptions } from "@/store/workspace";
import type { LayoutSize } from "@/lib/session/sidebarDock";

export const FILE_PANE_MIME = "application/x-tunnelde-file-pane";
let pending: {
  token: string;
  pane: FilePaneOptions;
  title: string;
  onMoved?: () => void;
  size?: LayoutSize;
} | null = null;
export function beginFilePaneDrag(
  pane: FilePaneOptions,
  title: string,
  onMoved?: () => void,
  size?: LayoutSize,
): string {
  const token = crypto.randomUUID();
  pending = { token, pane, title, onMoved, size };
  return token;
}
export function filePaneDrag(token: string) {
  return pending?.token === token ? pending : null;
}
export function clearFilePaneDrag() {
  pending = null;
}
