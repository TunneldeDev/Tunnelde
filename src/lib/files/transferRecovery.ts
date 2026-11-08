/** These outcomes need file review, rather than another copy or removal attempt. */
export function transferNeedsReview(error: string | null | undefined): boolean {
  return [
    "sftp.moveRecoverySourcePresent",
    "sftp.moveRecoveryUnverified",
    "sftp.moveSourceRetained",
    "sftp.directoryMoveSourceChanged",
    "sftp.namedStreamsMoveUnavailable",
    "sftp.backupPreserved",
    "sftp.transferArtifactUnrecognized",
  ].includes(error ?? "");
}
