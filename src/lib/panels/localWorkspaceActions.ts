import type { TFunction } from "i18next";
import type { MenuAction } from "@/components/ui/overlay/Menu";
import type { LocalPanelWorkspace } from "./localWorkspace";
export function localPanelMoveActions(
  workspace: LocalPanelWorkspace,
  panel: string,
  t: TFunction,
): MenuAction[] {
  const state = workspace.store.getState();
  const floating = state.floating.includes(panel);
  const count = state.groups.reduce((count, group) => count + group.panels.length, 0);
  return [
    {
      label: t(floating ? "docking.moveToWorkspace" : "panels.floatWindow"),
      separatorBefore: true,
      onSelect: () => (floating ? workspace.dock(panel) : workspace.float(panel)),
    },
    ...(
      [
        ["moveLeft", "row", "before"],
        ["moveRight", "row", "after"],
        ["moveTop", "column", "before"],
        ["moveBottom", "column", "after"],
      ] as const
    ).map(([label, direction, position]) => ({
      label: t(`docking.${label}`),
      disabled: count < (floating ? 1 : 2),
      onSelect: () => workspace.split(panel, direction, position),
    })),
    ...state.groups
      .filter((group) => !group.panels.includes(panel))
      .map((group, index) => ({
        label: t("panels.moveToGroup", { index: index + 1 }),
        onSelect: () => workspace.dock(panel, group.id),
      })),
  ];
}
