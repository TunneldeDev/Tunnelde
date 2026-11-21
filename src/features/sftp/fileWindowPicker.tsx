import { createRoot } from "react-dom/client";
import { FileRemoteDialog } from "./FileRemoteDialog";
import type { SshSession } from "@/lib/api/types";
let pending = false;
/** Real chooser/authentication stays in main. No credentials or ConnectDialog
 * bootstrap are copied into a satellite document. */
export function pickFileWindowRemote(): Promise<SshSession | null> {
  if (pending) return Promise.reject(new Error("panel interaction in progress"));
  pending = true;
  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let settled = false;
    const finish = (session: SshSession | null) => {
      if (settled) return;
      settled = true;
      pending = false;
      queueMicrotask(() => {
        root.unmount();
        container.remove();
        resolve(session);
      });
    };
    root.render(
      <FileRemoteDialog onClose={() => finish(null)} onConnected={(session) => finish(session)} />,
    );
  });
}
