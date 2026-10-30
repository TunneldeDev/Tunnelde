// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/format";

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
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
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
