import { observeFileBrowsers, readFileBrowser } from "@/lib/plugins/files/browser/data";
import { runFileBrowserAction } from "@/lib/plugins/files/browser/actions";

/** Native broker owns permission, runtime and cancellation; mutations get a final live check. */
export async function runFileBrowserRequest(
  method: string,
  params: unknown,
  authorize: () => Promise<void>,
) {
  switch (method) {
    case "fileBrowser.observe": {
      const result = await observeFileBrowsers(params);
      await authorize();
      return result;
    }
    case "fileBrowser.read":
      return readFileBrowser(params);
    case "fileBrowser.action":
      await authorize();
      return runFileBrowserAction(params);
    default:
      throw new Error("plugin.api.unknownMethod");
  }
}
