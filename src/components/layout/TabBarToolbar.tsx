import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menu, type MenuAction } from "@/components/ui/overlay/Menu";
import { fitTabBarItems, tabBarBudget } from "@/lib/plugins/tabBarLayout";

export interface TabBarEntry {
  id: string;
  group: string;
  content: ReactNode;
  actions?: MenuAction[];
}

export function TabBarToolbar({
  items,
  placement,
}: {
  items: TabBarEntry[];
  placement: "leading" | "trailing";
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [width, setWidth] = useState<number>();
  const signature = items.map((item) => `${item.id}:${!!item.actions?.length}`).join("|");
  useLayoutEffect(() => {
    const element = root.current;
    const header = element?.parentElement;
    if (!element || !header) return;
    const measure = () => {
      if (!header.clientWidth) return;
      const entries = Array.from(element.querySelectorAll<HTMLElement>("[data-contribution-id]"));
      const measurements = entries.map((entry) => ({
        id: entry.dataset.contributionId!,
        width: entry.getBoundingClientRect().width,
        canOverflow: entry.dataset.canOverflow === "true",
      }));
      const actions = header.querySelector<HTMLElement>(".pane__actions");
      const style = getComputedStyle(header);
      const contentWidth =
        header.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      const budget = tabBarBudget(
        contentWidth,
        actions?.offsetWidth ?? 0,
        placement,
        header.querySelectorAll(".tabbar-contributions").length > 1,
      );
      const next = fitTabBarItems(measurements, budget);
      setVisible((old) =>
        old && old.size === next.size && [...old].every((id) => next.has(id)) ? old : next,
      );
      setWidth(
        measurements.reduce((sum, item) => sum + (next.has(item.id) ? item.width : 0), 0) +
          (next.size < measurements.length ? 30 : 0),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    const mutation = new MutationObserver(measure);
    mutation.observe(header, { childList: true });
    element.querySelectorAll("[data-contribution-id]").forEach((entry) => observer.observe(entry));
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [signature, placement]);

  const overflow = items.filter((item) => visible && !visible.has(item.id));
  const actions = overflow.flatMap((item, index) =>
    (item.actions ?? []).map((action, actionIndex) => ({
      ...action,
      separatorBefore:
        action.separatorBefore ||
        (index > 0 && actionIndex === 0 && overflow[index - 1]?.group !== item.group),
    })),
  );
  return (
    <div
      ref={root}
      className={`tabbar-contributions tabbar-contributions--${placement}`}
      style={{ width }}
    >
      {items.map((item, index) => {
        const hidden = !!visible && !visible.has(item.id);
        return (
          <div
            className={`tabbar-contribution${hidden ? " is-overflowed" : ""}`}
            data-contribution-id={item.id}
            data-can-overflow={!!item.actions?.length}
            data-group-start={(index > 0 && items[index - 1]?.group !== item.group) || undefined}
            key={item.id}
            inert={hidden}
            aria-hidden={hidden || undefined}
          >
            {item.content}
          </div>
        );
      })}
      {actions.length ? (
        <Menu
          label={t("tab.actions")}
          items={actions}
          className="tabbar-contributions__more"
          menuClassName="tabbar-contributions__menu"
        />
      ) : null}
    </div>
  );
}
