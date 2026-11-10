/** Public experimental UI SDK 0.1.0 contract. */

export type FrontendProviderTarget =
  | "hostList"
  | "workbench"
  | "fileBrowser"
  | "terminal"
  | "history"
  | "forwarding"
  | "monitor"
  | "backgroundTasks"
  | "processes"
  | "quickAccess";
/** Optional manifest view field; requires kind: component and a trusted frontend. */
export interface FrontendProviderContribution {
  provider?: FrontendProviderTarget;
}
