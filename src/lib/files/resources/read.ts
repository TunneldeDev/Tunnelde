import type { FsSource } from "@/lib/api/types";
import { api } from "@/lib/api/ipc";
import { captureFileTarget } from "./target";
import { createResourceScope } from "@/lib/extensions/resourceScope";

/** Cancels delivery and owns late results; native IPC may still be running. */
export function createFileReadResource(path: string, source: FsSource) {
  return { target: captureFileTarget(path, source), scope: createResourceScope() };
}

export type FileReadResource = ReturnType<typeof createFileReadResource>;

export function readFileText(resource: FileReadResource, purpose: "editor" | "preview") {
  const { path, source } = resource.target;
  return resource.scope.run(async () => {
    if (source.kind === "remote") return (await api.sftpReadText(source.sessionId, path)).content;
    return purpose === "preview"
      ? api.searchPreviewLocal(path)
      : (await api.localReadText(path)).content;
  });
}
