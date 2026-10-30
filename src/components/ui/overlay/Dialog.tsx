// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
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
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Dialog({
  open,
  title,
  closeLabel,
  onClose,
  children,
  footer,
  width = 420,
  className,
}: DialogProps) {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panel.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) {
        return;
      }
      const nodes = panel.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = nodes.item(0);
      const last = nodes.item(nodes.length - 1);
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="td-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
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
          <IconButton label={closeLabel} size="sm" onClick={onClose}>
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
