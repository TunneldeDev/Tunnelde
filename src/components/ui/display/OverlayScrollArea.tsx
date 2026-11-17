import type { HTMLAttributes } from "react";
import "./overlayScrollArea.css";

/** Compatibility wrapper for a region that uses the browser's native scrolling. */
export function OverlayScrollArea({
  className = "",
  children,
  tabIndex = 0,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} tabIndex={tabIndex} className={`td-scroll-area ${className}`}>
      {children}
    </div>
  );
}
