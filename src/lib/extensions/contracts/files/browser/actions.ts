/** Dispatches existing host behavior; acceptance is not filesystem completion. */
export type FileBrowserAction = {
  readonly paneId: string;
  readonly revision: string;
} & (
  | { readonly action: "refresh" }
  | { readonly action: "navigate"; readonly path: string }
  | { readonly action: "select"; readonly paths: readonly string[] }
  | { readonly action: "open"; readonly path: string; readonly mode?: "open" | "preview" }
);

export interface FileBrowserActionResult {
  readonly accepted: true;
}
