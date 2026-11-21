import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";

type Attachment =
  { id: string; status: "ready"; url: string } | { id: string; status: "error"; cause: unknown };
/** A presentation attachment, NOT a source opener. Staged promotion keeps the
 * same owner/attempt and native handle; changing the lease must not reacquire. */
export function useWindowPreviewHandle(owner: WindowProviderOwner, resourceId: string | null) {
  const [value, setValue] = useState<Attachment | null>(null);
  useEffect(() => {
    if (!resourceId) return;
    const lifetime = new AbortController();
    let current: { dispose(): void } | undefined;
    void (async () => {
      try {
        owner.check(false);
        const handle = await owner.client.openPreviewHandle(
          owner.target(),
          resourceId,
          lifetime.signal,
        );
        current = handle;
        if (lifetime.signal.aborted) {
          handle.dispose();
          return;
        }
        owner.check(false);
        setValue({ id: resourceId, status: "ready", url: convertFileSrc(handle.id, "preview") });
      } catch (cause) {
        current?.dispose();
        if (!lifetime.signal.aborted) setValue({ id: resourceId, status: "error", cause });
      }
    })();
    return () => {
      lifetime.abort();
      current?.dispose();
    };
  }, [owner, resourceId]);
  if (!resourceId) return { status: "none" as const };
  return value?.id === resourceId ? value : { status: "loading" as const };
}
