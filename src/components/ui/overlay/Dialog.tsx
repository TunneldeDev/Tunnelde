// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/form/Button";
import { cn } from "@/lib/text/format";

interface DialogProps {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  dismissible?: boolean;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => {
    if (
      node.tabIndex < 0 ||
      node.matches(':disabled, input[type="hidden"]') ||
      node.closest("[hidden], [aria-hidden='true'], [inert]")
    )
      return false;
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (ancestor === panel) break;
    }
    return true;
  });
}

export function Dialog(props: DialogProps) {
  return props.open ? <DialogContent {...props} /> : null;
}

function DialogContent({
  open,
  title,
  closeLabel,
  onClose,
  children,
  footer,
  width = 420,
  className,
  dismissible = true,
}: DialogProps) {
  const panel = useRef<HTMLElement>(null);
  // Capture before descendant autoFocus runs during the DOM commit.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      const current = panel.current;
      if (current && !current.contains(document.activeElement)) {
        const nodes = focusableElements(current);
        (
          nodes.find((node) => node.hasAttribute("autofocus")) ??
          nodes.find((node) => node.matches("input, textarea")) ??
          nodes[0] ??
          current
        ).focus();
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, previous]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(".td-dialog");
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (event.key === "Escape") {
        if (event.defaultPrevented || event.isComposing || !panel.current) return;
        const controlledPopup = Array.from(
          panel.current.querySelectorAll<HTMLElement>('[aria-expanded="true"][aria-controls]'),
        ).some((element) =>
          element
            .getAttribute("aria-controls")
            ?.split(/\s+/)
            .some((id) => !!document.getElementById(id)),
        );
        if (
          controlledPopup ||
          (panel.current.contains(document.activeElement) &&
            document.querySelector(".td-menu, .context-menu"))
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (dismissible) onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) {
        return;
      }
      const nodes = focusableElements(panel.current);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
      const outside = !panel.current.contains(document.activeElement);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current || outside)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === panel.current || outside)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, dismissible]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="td-backdrop"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={panel}
        tabIndex={-1}
        className={cn("td-dialog", className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
      >
        <header className="td-dialog__head">
          <h2 className="td-dialog__title">{title}</h2>
          <IconButton label={closeLabel} size="sm" disabled={!dismissible} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </header>
        <div className="td-dialog__body">{children}</div>
        {footer ? <footer className="td-dialog__foot">{footer}</footer> : null}
      </section>
    </div>,
    document.body,
  );
}
