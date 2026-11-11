import type { FrontendFileBrowser } from "@/lib/extensions/contracts/files/browser";

export type LiveFileBrowser = {
  readonly browser: Omit<FrontendFileBrowser, "Entries">;
  readonly tabId: string | null;
  readonly suspended: boolean;
};

type Slot = { value: LiveFileBrowser | null };
const browsers = new Map<string, Slot>();
let revision = crypto.randomUUID();
const changed = () => {
  revision = crypto.randomUUID();
};

/** A committed component owns a slot. An old cleanup cannot remove a replacement. */
export function mountFileBrowser(paneId: string) {
  const slot: Slot = { value: null };
  if (browsers.has(paneId)) throw new Error("plugin.fileBrowser.changed");
  browsers.set(paneId, slot);
  let disposed = false;
  return Object.freeze({
    publish(value: LiveFileBrowser) {
      if (disposed || browsers.get(paneId) !== slot) return;
      if (value.browser.snapshot.paneId !== paneId) throw new Error("plugin.fileBrowser.invalid");
      slot.value = Object.freeze({ ...value });
      changed();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (browsers.get(paneId) === slot) {
        browsers.delete(paneId);
        changed();
      }
    },
  });
}

/** Only committed live contexts. No retained file contents or independent listing cache. */
export function fileBrowserCatalogue() {
  return {
    revision,
    items: [...browsers.values()].flatMap((slot) => (slot.value ? [slot.value] : [])),
  };
}

export function liveFileBrowser(paneId: string, expected: string): LiveFileBrowser {
  const value = browsers.get(paneId)?.value;
  if (!value || value.browser.snapshot.revision !== expected)
    throw new Error("plugin.fileBrowser.changed");
  return value;
}
