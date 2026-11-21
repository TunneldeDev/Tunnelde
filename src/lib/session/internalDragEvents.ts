/** Private same-document lifecycle, not a plugin bus or native authorization. */
export const INTERNAL_DRAG_FINISH = "tunnelde:internal-drag-finish";
/** Readiness metadata only, never the native authority token. */
export const NATIVE_PANEL_DRAG_READY = "application/x-tunnelde-native-panel-ready";
export interface InternalDragFinish {
  transfer: DataTransfer;
  released: boolean;
  accepted: boolean;
}
