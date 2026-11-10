/** Internal, process-bound admission. This is not a public SDK capability. */
export interface StartPermit {
  fingerprint: string;
  stamp: string;
}

/** Internal request for an already admitted runtime while start IPC is pending. */
export interface FrontendActivation {
  id: string;
  runtimeId: string;
}
