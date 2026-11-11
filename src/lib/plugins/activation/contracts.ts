import type { PluginInfo } from "@/lib/api/types";

export interface PackageReview {
  id: string;
  fingerprint: string;
}

/** Minimal identity, executable trust and publisher provenance for consent. */
export type PluginApproval = Pick<
  PluginInfo,
  | "id"
  | "name"
  | "version"
  | "fingerprint"
  | "runtime"
  | "permissions"
  | "author"
  | "path"
  | "sourceUrl"
  | "frontend"
>;

/** Internal, process-bound admission. This is not a public SDK capability. */
export interface StartPermit {
  fingerprint: string;
  stamp: string;
  packages?: Array<PackageReview & { stamp: string }>;
}

/** Installed, dependencies-first review. Obtaining it never grants or starts. */
export interface ActivationPlan {
  root: string;
  packages: PluginApproval[];
}

/** Internal request for an already admitted runtime while start IPC is pending. */
export interface FrontendActivation {
  id: string;
  runtimeId: string;
}
