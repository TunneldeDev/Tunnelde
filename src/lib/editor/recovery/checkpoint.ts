import { flushEditorDrafts } from "./persistence";
import { reportDraftRecoveryFailure } from "./notifications";

/** A failed checkpoint reports once and prevents the caller's destructive
 * transition. Native action/install failures retain their own error handling. */
export async function checkpointEditorDrafts(
  canReport: () => boolean = () => true,
): Promise<boolean> {
  try {
    await flushEditorDrafts();
    return true;
  } catch (error) {
    if (canReport()) reportDraftRecoveryFailure(error);
    return false;
  }
}
