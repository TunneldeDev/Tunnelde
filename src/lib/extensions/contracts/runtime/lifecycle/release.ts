export interface RuntimeResourceRelease {
  handle: string;
}
export interface RuntimeResourceReleased {
  handle: string;
  /** Cancellation is a request; process/transfer resources remain live until their workers settle. */
  outcome: "released" | "cancellationRequested";
}
