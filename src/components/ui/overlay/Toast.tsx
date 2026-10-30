// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

import { IconButton } from "@/components/ui/form/Button";
import { cn } from "@/lib/text/format";
import { useToasts } from "@/store/toasts";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const;

export function ToastHost() {
  const items = useToasts((state) => state.items);
  const dismiss = useToasts((state) => state.dismiss);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="td-toasts" role="status" aria-live="polite">
      {items.map((toast) => {
        const Icon = ICONS[toast.variant];
        return (
          <div key={toast.id} className={cn("td-toast", `td-toast--${toast.variant}`)}>
            <Icon size={14} className="td-toast__icon" />
            <span className="td-toast__text">{toast.message}</span>
            <IconButton label="dismiss" size="sm" onClick={() => dismiss(toast.id)}>
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
