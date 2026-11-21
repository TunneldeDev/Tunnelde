import { observeFilePreview, readFilePreviewProviders } from "@/lib/plugins/files/preview/data";
import { openFilePreview, runFilePreviewAction } from "@/lib/plugins/files/preview/actions";

export async function runFilePreviewRequest(
  method: string,
  params: unknown,
  authorize: () => Promise<void>,
) {
  // Native open requests retain the source-specific read grant through reply/cancellation.
  await authorize();
  switch (method) {
    case "filePreview.observe":
      return observeFilePreview(params);
    case "filePreview.providers":
      return readFilePreviewProviders(params);
    case "filePreview.action":
      await authorize();
      return runFilePreviewAction(params);
    case "filePreview.open":
      await authorize();
      return openFilePreview(params);
    default:
      throw new Error("plugin.api.unknownMethod");
  }
}
