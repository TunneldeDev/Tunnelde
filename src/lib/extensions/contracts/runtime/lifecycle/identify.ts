import type { RuntimeResourceKind } from "./resource.js";

/** Observe the current owned instance by its existing public domain ID.
 * connection=sessionId, forward=ruleId, mount=mountId, task=taskId, transfer=transferId, fileContent=contentId.
 * This does not prove that an earlier creation request produced this instance.
 */
export interface RuntimeResourceReference {
  kind: RuntimeResourceKind;
  id: string;
}
