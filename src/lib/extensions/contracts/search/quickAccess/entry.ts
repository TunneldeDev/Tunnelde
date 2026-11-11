/** Public experimental UI SDK 0.1.0 contract. */
export interface FrontendQuickAccessEntry {
  /** Opaque identity valid only within one snapshot revision. */
  key: string;
  kind: "command" | "host" | "tab" | "file";
  title: string;
  detail: string | null;
  fileName: string | null;
  filePath: string | null;
  commandId: string | null;
  truncated: boolean;
}
