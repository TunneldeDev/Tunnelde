import type { TFunction } from "i18next";
import { afterEach, expect, it } from "vitest";
import { nativePanelMoveActions } from "@/lib/panels/windowMoves";
import { usePanelWindows } from "@/store/panelWindows";

const initial = usePanelWindows.getState();
const t = ((key: string) => key) as TFunction;
afterEach(() => usePanelWindows.setState(initial, true));

it("offers forwarding detachment and existing-window moves only for the exact local owner", () => {
  usePanelWindows.setState({
    available: true,
    windowId: "main",
    snapshot: {
      windows: [
        { id: "main", ready: true, closing: false },
        { id: "satellite", ready: true, closing: false },
        { id: "loading", ready: false, closing: false },
      ],
      panels: [{ panelId: "forwarding", windowId: "main", generation: 3 }],
      transfers: [],
    },
  });
  expect(nativePanelMoveActions("forwarding", t).map((action) => action.label)).toEqual([
    "panels.newWindow",
    "panels.moveToWindow",
  ]);
  expect(nativePanelMoveActions("hosts", t)).toEqual([]);
  usePanelWindows.setState({ windowId: "satellite" });
  expect(nativePanelMoveActions("forwarding", t)).toEqual([]);
  usePanelWindows.setState({ windowId: "main", available: false });
  expect(nativePanelMoveActions("forwarding", t)).toEqual([]);
});
