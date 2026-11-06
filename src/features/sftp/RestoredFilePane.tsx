import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { Button } from "@/components/ui/form/Button";
import { FileRemoteDialog } from "./FileRemoteDialog";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

/** A restored tab never opens a connection or trusts a host without user action. */
export function RestoredFilePane({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pane = tab.filePane!;
  return (
    <div className="page">
      <EmptyState
        icon={<StatusDot tone="warn" />}
        title={t("sftp.restoreRemoteTitle")}
        body={t("sftp.restoreRemoteBody", { address: pane.remoteIdentity?.address ?? tab.title })}
        action={
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t("sftp.connectRemote")}
          </Button>
        }
      />
      {open ? (
        <FileRemoteDialog
          onClose={() => setOpen(false)}
          onConnected={(session) => {
            const same =
              session.hostId === pane.remoteIdentity?.hostId &&
              session.address === pane.remoteIdentity.address;
            useWorkspace.getState().retainFilePane(
              tab.id,
              {
                ...pane,
                offline: false,
                source: { kind: "remote", sessionId: session.id },
                path: same ? pane.path : null,
                ownerSessionId: session.id,
                remoteIdentity: { hostId: session.hostId, address: session.address },
              },
              session.title,
            );
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
