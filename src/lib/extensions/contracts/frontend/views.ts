/** Public experimental UI SDK 0.1.0 contract. */
import type { FrontendWorkbenchSlots } from "../workbench/slots.js";
import type { FrontendFileBrowser } from "../files/browser.js";
import type { FrontendTerminal } from "../terminal/surface.js";
import type { FrontendHistory } from "../history/provider.js";

export interface FrontendViewProps {
  pluginId: string;
  viewId: string;
  visible: boolean;
  /** Present only for a user-selected workbench provider. Mount Workspace synchronously
   * exactly once and keep it mounted. Omitting other surfaces is allowed.
   */
  workbench?: FrontendWorkbenchSlots;
  /** Present only inside an explicitly selected file-browser provider. */
  fileBrowser?: FrontendFileBrowser;
  /** Present only for a user-selected terminal provider. */
  terminal?: FrontendTerminal;
  /** Present only for a user-selected command-history provider. */
  history?: FrontendHistory;
}
