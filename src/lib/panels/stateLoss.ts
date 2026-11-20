/** Document-local instance identity, never serialized or a plugin capability. */
export interface PanelStateLoss {
  readonly pluginId: string;
  readonly viewId: string;
}
export class PanelStateLossRequired extends Error {
  constructor(readonly views: readonly PanelStateLoss[]) {
    super("plugin.frontend.viewStateUnavailable");
  }
}
export interface PanelCaptureOptions {
  /** A periodic checkpoint is not permission to suspend a live resource.
   * Only an explicit move may retain a detach/ownership-transfer barrier. */
  readonly intent?: "checkpoint" | "move";
  readonly consentedStateLoss?: ReadonlySet<PanelStateLoss>;
}
