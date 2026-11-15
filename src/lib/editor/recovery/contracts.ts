/** Private native IPC. These drafts convey text, never a reusable SSH session. */
export type DraftSource = { kind: "local" } | { kind: "remote"; hostId: string; address: string };
export interface EditorDraft {
  id: string;
  path: string;
  source: DraftSource;
  baseline: string;
  content: string;
}
export interface DraftSnapshot {
  revision: string;
  drafts: EditorDraft[];
}
