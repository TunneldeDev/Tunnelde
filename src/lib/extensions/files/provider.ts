import type { FrontendFileBrowser } from "../contracts/files/browser";
import type { CheckProviderAccess } from "../runtime/providers/access";

/** Defer permission and lifetime checks until a retained callback is invoked. */
export function guardFileBrowserProvider(
  browser: FrontendFileBrowser,
  checkAccess: CheckProviderAccess,
): FrontendFileBrowser {
  return Object.freeze<FrontendFileBrowser>({
    Entries: browser.Entries,
    snapshot: browser.snapshot,
    read: (request) => {
      checkAccess(false);
      return browser.read(request);
    },
    navigate: (path) => {
      checkAccess();
      browser.navigate(path);
    },
    refresh: () => {
      checkAccess();
      browser.refresh();
    },
    select: (paths) => {
      checkAccess();
      browser.select(paths);
    },
    open: (path, mode) => {
      checkAccess();
      browser.open(path, mode);
    },
  });
}
