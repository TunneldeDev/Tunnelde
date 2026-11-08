/** Reserve a closeable tab and account for both slots and native window controls. */
export function tabBarBudget(
  width: number,
  actions: number,
  placement: "leading" | "trailing",
  both: boolean,
): number {
  const fraction = placement === "leading" ? 0.25 : 0.45;
  const available = Math.max(0, width - actions - 88 - (both ? 16 : 8));
  return Math.max(0, Math.min(width * fraction, available * (both ? fraction / 0.7 : 1)));
}

/** Keep high-priority controls visible; controls without a menu equivalent stay inline. */
export function fitTabBarItems(
  items: { id: string; width: number; canOverflow: boolean }[],
  available: number,
  moreWidth = 30,
): Set<string> {
  const visible = new Set(items.map((item) => item.id));
  let used = items.reduce((sum, item) => sum + item.width, 0);
  if (used <= available) return visible;
  used += moreWidth;
  for (let index = items.length - 1; index >= 0 && used > available; index--) {
    const item = items[index]!;
    if (item.canOverflow) {
      visible.delete(item.id);
      used -= item.width;
    }
  }
  return visible;
}

/** Explicit groups stay together; group IDs are scoped by the registering owner. */
export function groupTabBarItems<T extends { id: string; group: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.group);
    if (group) group.push(item);
    else groups.set(item.group, [item]);
  }
  return [...groups.values()].flat();
}
