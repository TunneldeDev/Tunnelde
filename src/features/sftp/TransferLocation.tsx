import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { parentOf } from "@/lib/files/dnd";
import { useSsh } from "@/store/ssh";
import type { TransferItem } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";

/** Resolve only the captured host identity; a disconnected remote is never local. */
export function TransferLocation({
  item,
  side,
  path,
  label,
  inspect = false,
}: {
  item: TransferItem;
  side: "from" | "to";
  path: string;
  label: string;
  inspect?: boolean;
}) {
  const { t } = useTranslation();
  const sessions = useSsh((state) => state.sessions);
  const hostId = item[`${side}HostId`];
  const address = item[`${side}Address`];
  const oldSession = item[`${side}Session`];
  const local = hostId === null && oldSession === null && !address;
  const remote = sessions.find(
    (session) =>
      session.purpose !== "forwarding" && session.hostId === hostId && session.address === address,
  );
  return (
    <p>
      <span className="transfer-task__location-label">
        {label}
        {inspect ? (
          <IconButton
            label={t("sftp.inspectTransferLocation", { location: label })}
            title={!local && !remote ? t("sftp.reconnectRequired") : path}
            size="sm"
            disabled={!local && !remote}
            onClick={() => {
              // Recheck at click time: the connection may have ended or changed
              // while this task's menu or recovery instructions were visible.
              const live =
                remote &&
                useSsh
                  .getState()
                  .sessions.find(
                    (session) =>
                      session.id === remote.id &&
                      session.hostId === hostId &&
                      session.address === address &&
                      session.purpose !== "forwarding",
                  );
              if (!local && !live) return;
              useWorkspace.getState().openFilePane(
                {
                  source: live ? { kind: "remote", sessionId: live.id } : { kind: "local" },
                  path: live ? path.slice(0, path.lastIndexOf("/")) || "/" : parentOf(path),
                  ownerSessionId: live?.id ?? "local",
                  remoteIdentity: live ? { hostId: live.hostId, address: live.address } : undefined,
                },
                live?.title ?? t("sftp.thisComputer"),
              );
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
