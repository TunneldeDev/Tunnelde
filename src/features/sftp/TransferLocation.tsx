import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import type { TransferItem } from "@/store/transfers";
import { presentError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { useTransferLocation, type TransferLocationKind } from "./transferTaskController";

/** Resolve only the captured host identity; a disconnected remote is never local. */
export function TransferLocation({
  item,
  side,
  path,
  label,
  inspect = false,
  location = side,
}: {
  item: TransferItem;
  side: "from" | "to";
  path: string;
  label: string;
  inspect?: boolean;
  location?: TransferLocationKind;
}) {
  const { t } = useTranslation();
  const action = useTransferLocation(item, location, path);
  const address = item[`${side}Address`];
  return (
    <p>
      <span className="transfer-task__location-label">
        {label}
        {inspect ? (
          <IconButton
            label={t("sftp.inspectTransferLocation", { location: label })}
            title={!action.available ? t("sftp.reconnectRequired") : path}
            size="sm"
            disabled={!action.available}
            onClick={() => {
              try {
                void Promise.resolve(action.open()).catch((error: unknown) =>
                  toast(presentError(error), "error"),
                );
              } catch (error) {
                toast(presentError(error), "error");
              }
            }}
          >
            <FolderOpen size={13} />
          </IconButton>
        ) : null}
      </span>
      <code>
        {address ? `${address}:` : ""}
        {path}
      </code>
    </p>
  );
}
