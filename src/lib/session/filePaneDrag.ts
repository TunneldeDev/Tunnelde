import type { FilePaneOptions } from "@/store/workspace";

export const FILE_PANE_MIME = "application/x-tunnelde-file-pane";
let pending: { token: string; pane: FilePaneOptions; title: string; onMoved?: () => void } | null =
  null;
export function beginFilePaneDrag(
  pane: FilePaneOptions,
  title: string,
  onMoved?: () => void,
): string {
  const token = crypto.randomUUID();
  pending = { token, pane, title, onMoved };
  return token;
}
export function filePaneDrag(token: string) {
  return pending?.token === token ? pending : null;
}
export function clearFilePaneDrag() {
  pending = null;
}
