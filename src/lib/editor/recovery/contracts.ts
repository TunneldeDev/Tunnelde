/** Private native IPC. These drafts convey text, never a reusable SSH session. */
import type { TextEncoding } from "@/lib/api/types";

export type DraftSource = { kind: "local" } | { kind: "remote"; hostId: string; address: string };
export interface EditorDraft {
  id: string;
  path: string;
  source: DraftSource;
  baseline: string;
  content: string;
  encoding?: TextEncoding;
  bom?: boolean;
  baselineEncoding?: TextEncoding;
  baselineBom?: boolean;
}
export interface DraftSnapshot {
  revision: string;
  drafts: EditorDraft[];
}
