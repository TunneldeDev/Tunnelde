import { create } from "zustand";
import type { NativePanelSnapshot } from "@/lib/panels/windowProtocol";

/** Metadata only. Native document tokens and private view capsules never enter
 * persisted layout state or public plugin discovery/events. */
export const usePanelWindows = create<{
  windowId: string;
  available: boolean;
  snapshot: NativePanelSnapshot;
}>(() => ({
  windowId: "main",
  available: false,
  snapshot: { windows: [], panels: [], transfers: [] },
}));
