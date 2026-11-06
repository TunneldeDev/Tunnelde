import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { cn } from "@/lib/text/format";
import { useToasts } from "@/store/toasts";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const;

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
            {toast.action ? (
              <button
                type="button"
                className="td-toast__action"
                onClick={() => void toast.action?.onClick()}
              >
                {toast.action.label}
              </button>
            ) : null}
            <IconButton label={t("common.close")} size="sm" onClick={() => dismiss(toast.id)}>
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
