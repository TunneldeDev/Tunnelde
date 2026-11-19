import type { PanelLease } from "./windowProtocol";
import type { MenuAction } from "@/components/ui/overlay/Menu";
import type { TFunction } from "i18next";
import { windowViews, transferablePanel } from "./windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";

const moving = new Set<string>();
export async function movePanelToWindow(
  panelId: string,
  target?: string,
  expected?: PanelLease,
  operationId?: string,
) {
  const views = windowViews();
  if (!views || !transferablePanel(panelId)) throw new Error("panel.window.unsupportedView");
  const client = views.client;
  if (moving.has(panelId)) throw new Error("panel.window.moveInProgress");
  moving.add(panelId);
  views.setMoving(panelId, true);
  let created: string | undefined;
  let committed = false;
  try {
    const snapshot = await client.snapshot();
    const lease = snapshot.panels.find(
      (panel) => panel.panelId === panelId && panel.windowId === client.windowId,
    );
    if (
      !lease ||
      (expected &&
        (expected.panelId !== lease.panelId ||
          expected.windowId !== lease.windowId ||
          expected.generation !== lease.generation))
    )
      throw new Error("panel.window.staleOwner");
    if (!target) {
      // Native checks this exact document/lease before AND after platform window
      // construction. Satellites cannot create arbitrary unowned windows.
      target = created = await client.create(lease);
      const deadline = Date.now() + 18_000;
      while (Date.now() < deadline) {
        const current = await client.snapshot();
        if (
          current.windows.some((window) => window.id === target && window.ready && !window.closing)
        )
          break;
        if (!current.windows.some((window) => window.id === target))
          throw new Error("panel.window.destinationUnavailable");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const state = views.capture(panelId);
    const offer = await client.control<{ id: string }>(
      operationId
        ? { action: "preparePanelMove", id: operationId, state }
        : { action: "prepare", lease, targetWindow: target, state },
    );
    const deadline = Date.now() + 17_000;
    while (Date.now() < deadline) {
      const current = await client.snapshot();
      if (
        current.panels.some(
          (panel) =>
            panel.panelId === panelId &&
            panel.windowId === target &&
            panel.generation !== lease.generation,
        )
      ) {
        committed = true;
        return;
      }
      if (!current.transfers.some(({ offer: pending }) => pending.id === offer.id))
        throw new Error("panel.window.cancelled");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await client.control({ action: "cancel", id: offer.id }).catch(() => {});
    throw new Error("panel.window.timeout");
  } catch (error) {
    if (created) await client.destroy(created).catch(() => {});
    throw error;
  } finally {
    moving.delete(panelId);
    // Native commit can precede the source React unmount by a frame. Never
    // re-enable that retired source while its invalidation is still queued.
    if (!committed) views.setMoving(panelId, false);
  }
}

export function nativePanelMoveActions(panelId: string, t: TFunction): MenuAction[] {
  const state = usePanelWindows.getState();
  if (!state.available || !transferablePanel(panelId)) return [];
  if (
    !state.snapshot.panels.some(
      (panel) => panel.panelId === panelId && panel.windowId === state.windowId,
    )
  )
    return [];
  const move = (target?: string) => {
    void movePanelToWindow(panelId, target).catch((error) => toast(translateError(error), "error"));
  };
  return [
    { label: t("panels.newWindow"), separatorBefore: true, onSelect: () => move() },
    ...state.snapshot.windows
      .filter((window) => window.id !== state.windowId && window.ready && !window.closing)
      .map((window, index) => ({
        label:
          window.id === "main"
            ? t("panels.returnToMainWindow")
            : t("panels.moveToWindow", { index: index + 1 }),
        onSelect: () => move(window.id),
      })),
  ];
}
