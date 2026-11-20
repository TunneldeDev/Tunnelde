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
  readonly consentedStateLoss?: ReadonlySet<PanelStateLoss>;
}
