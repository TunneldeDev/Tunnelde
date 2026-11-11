import { liveFileBrowser } from "@/lib/files/browser/registry";
import { object, path, token } from "./validation";

export function runFileBrowserAction(input: unknown): { accepted: true } {
  const kind = object(input, ["paneId", "revision", "action", "path", "paths", "mode"]);
  const fields =
    kind.action === "refresh"
      ? ["paneId", "revision", "action"]
      : kind.action === "select"
        ? ["paneId", "revision", "action", "paths"]
        : kind.action === "navigate"
          ? ["paneId", "revision", "action", "path"]
          : kind.action === "open"
            ? ["paneId", "revision", "action", "path", "mode"]
            : null;
  if (!fields) throw new Error("plugin.fileBrowser.invalid");
  const request = object(input, fields);
  const { browser, suspended } = liveFileBrowser(token(request.paneId), token(request.revision));
  if (suspended) throw new Error("plugin.fileBrowser.busy");
  switch (request.action) {
    case "refresh":
      browser.refresh();
      break;
    case "navigate":
      browser.navigate(path(request.path));
      break;
    case "select": {
      if (!Array.isArray(request.paths) || request.paths.length > 256)
        throw new Error("plugin.fileBrowser.invalid");
      browser.select(request.paths.map(path));
      break;
    }
    case "open":
      if (request.mode !== undefined && request.mode !== "open" && request.mode !== "preview")
        throw new Error("plugin.fileBrowser.invalid");
      browser.open(path(request.path), request.mode);
      break;
  }
  return { accepted: true };
}
