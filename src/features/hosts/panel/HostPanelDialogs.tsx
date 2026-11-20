import { HostTransferDialogs } from "../HostTransferDialogs";
import { SshConfigImportDialog } from "@/features/welcome/SshConfigImportDialog";
import { useHostPanelDialogs } from "./execute";
/** Coordinator-owned modal drafts survive moving or closing the host list. */
export function HostPanelDialogs() {
  const sshImport = useHostPanelDialogs((state) => state.sshImport);
  return (
    <>
      <HostTransferDialogs />
      {sshImport ? (
        <SshConfigImportDialog onClose={() => useHostPanelDialogs.setState({ sshImport: false })} />
      ) : null}
    </>
  );
}
