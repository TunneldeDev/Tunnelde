/** Public experimental UI SDK 0.1.0 contract. */
import type { FrontendWorkbenchSlots } from "../workbench/slots.js";
import type { FrontendFileBrowser } from "../files/browser.js";
import type { FrontendTerminal } from "../terminal/surface.js";
import type { FrontendHistory } from "../history/provider.js";
import type { FrontendForwarding } from "../forwarding/provider.js";
import type { FrontendMonitor } from "../monitor/provider.js";

import type { FrontendBackgroundTasks } from "../backgroundTasks/provider.js";

import type { FrontendProcesses } from "../monitor/processes/provider.js";

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
  /** Present only for an explicitly selected forwarding provider, scoped to one saved host. */
  forwarding?: FrontendForwarding;
  /** Present only for a selected monitoring provider; sampling stays host-owned. */
  monitor?: FrontendMonitor;
  /** Present only for a selected shared background-task provider. */
  backgroundTasks?: FrontendBackgroundTasks;
  /** Present only for a selected process manager provider. */
  processes?: FrontendProcesses;
}
