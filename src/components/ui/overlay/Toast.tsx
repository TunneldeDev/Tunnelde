import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";

import { IconButton } from "@/components/ui/form/Button";
import { cn } from "@/lib/text/format";
import { toast as notify, useToasts, type Toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const;

function ToastAction({ toast }: { toast: Toast }) {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (active.current || !toast.action) return;
    active.current = true;
    setBusy(true);
    try {
      await toast.action.onClick();
      useToasts.getState().dismiss(toast.id);
    } catch (error) {
      reportError("notifications", "action", error);
      // A dismissed notification must not come back through a late failure.
      if (useToasts.getState().items.some((item) => item.id === toast.id))
        notify(translateError(error), "error");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="td-toast__action"
      disabled={busy}
      aria-busy={busy}
      onClick={() => void run()}
    >
      {toast.action?.label}
    </button>
  );
}

export function ToastHost() {
  const { t } = useTranslation();
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
          <div
            key={toast.id}
            className={cn("td-toast", `td-toast--${toast.variant}`, toast.action && "has-action")}
          >
            <Icon size={14} className="td-toast__icon" />
            <span className="td-toast__text">{toast.message}</span>
            {toast.action ? <ToastAction toast={toast} /> : null}
            <IconButton label={t("common.close")} size="sm" onClick={() => dismiss(toast.id)}>
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
