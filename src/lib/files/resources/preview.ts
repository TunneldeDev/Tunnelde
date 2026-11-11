import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/api/ipc";
import type {
  FilePreviewInfo,
  FilePreviewRenderer,
  FsSource,
  PluginFilePreview,
} from "@/lib/api/types";
import { readPreviewRange } from "@/lib/files/preview";
import { createFileReadResource } from "./read";

const limits: Record<FilePreviewRenderer, number> = {
  text: 2 * 1024 * 1024,
  markdown: 2 * 1024 * 1024,
  image: 32 * 1024 * 1024,
  pdf: 128 * 1024 * 1024,
  audio: 1024 ** 4,
  video: 1024 ** 4,
};

function validateInfo(info: FilePreviewInfo, id: string, renderer: FilePreviewRenderer) {
  if (
    !info ||
    info.id !== id ||
    info.renderer !== renderer ||
    !Object.hasOwn(limits, renderer) ||
    !Number.isSafeInteger(info.size) ||
    info.size < 0
  )
    throw { code: "validation", message: "preview.invalidTicket" };
  if (info.size > limits[renderer]) throw { code: "validation", message: "sftp.fileTooLarge" };
  return Object.freeze({ id, renderer, size: info.size });
}

/** Host-owned ticket. Providers select a renderer; they never receive this handle. */
export function createProviderPreviewResource(
  path: string,
  source: FsSource,
  provider: Pick<PluginFilePreview, "id" | "renderer">,
) {
  const { target, scope } = createFileReadResource(path, source);
  const id = crypto.randomUUID();
  const providerId = provider.id;
  const renderer = provider.renderer;
  let opened = false;
  const close = () => api.filePreviewClose(id).catch(() => {});
  // Closing before provider discovery/registration must be followed by closing a late result.
  scope.use(() => {
    if (!opened) return close();
  });
  const ready = (async () => {
    try {
      const result = await scope.acquire(async () => {
        const info = await api.filePreviewOpen(
          id,
          providerId,
          target.path,
          target.source.kind === "remote" ? target.source.sessionId : null,
        );
        opened = true;
        return info;
      }, close);
      scope.signal.throwIfAborted();
      const info = validateInfo(result, id, renderer);
      let content: string | null = null;
      if (renderer === "text" || renderer === "markdown") {
        content = await scope.run(async (signal) => {
          const bytes = new Uint8Array(info.size);
          for (let start = 0; start < info.size; start += 1024 * 1024) {
            signal.throwIfAborted();
            const end = Math.min(start + 1024 * 1024, info.size);
            const chunk = await readPreviewRange(convertFileSrc(id, "preview"), start, end, signal);
            signal.throwIfAborted();
            bytes.set(chunk, start);
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0")) throw { code: "validation", message: "sftp.binaryFile" };
          return text;
        });
      }
      scope.signal.throwIfAborted();
      return { info, content };
    } catch (error) {
      scope.dispose();
      throw error;
    }
  })();
  return { ready, signal: scope.signal, dispose: scope.dispose };
}
