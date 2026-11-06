import { Check } from "lucide-react";
import { Fragment, useId } from "react";

import { cn } from "@/lib/text/format";
import type { MenuAction } from "./menuTypes";

/** Pointer menus and button menus share layout, semantics and item behavior. */
export function MenuItems({
  items,
  onSelect,
}: {
  items: MenuAction[];
  onSelect: (item: MenuAction) => void;
}) {
  const id = useId();
  const hasIcons = items.some((item) => item.icon);
  return items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 && item.separatorBefore ? (
        <div className="td-menu__separator" role="separator" />
      ) : null}
      <button
        type="button"
        role={
          item.checked === undefined
            ? "menuitem"
            : item.checkable === "checkbox"
              ? "menuitemcheckbox"
              : "menuitemradio"
        }
        aria-label={item.label}
        aria-describedby={item.description ? `${id}-description-${index}` : undefined}
        aria-checked={item.checked}
        disabled={item.disabled}
        tabIndex={-1}
        className={cn(
          "td-menu__item",
          item.description && "td-menu__item--description",
          item.danger && "is-danger",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (!item.disabled) onSelect(item);
        }}
      >
        {hasIcons ? (
          <span className="td-menu__icon" aria-hidden="true">
            {item.icon}
          </span>
        ) : null}
        <span className={item.description ? "td-menu__item-text" : "td-menu__item-label"}>
          {item.description ? (
            <>
              <span>{item.label}</span>
              <small id={`${id}-description-${index}`}>{item.description}</small>
            </>
          ) : (
            item.label
          )}
        </span>
        {item.checked ? <Check size={13} aria-hidden="true" className="td-menu__check" /> : null}
      </button>
    </Fragment>
  ));
}
