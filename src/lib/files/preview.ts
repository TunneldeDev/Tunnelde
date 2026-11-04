import type { PluginInfo, PluginFilePreview } from "@/lib/api/types";

export function previewProviders(plugins: PluginInfo[]) {
  return plugins
    .flatMap((plugin) =>
      (plugin.filePreviews ?? []).map((provider) => ({
        ...provider,
        id: `${plugin.id}:${provider.id}`,
        pluginName: plugin.name,
      })),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function matchesPreview(provider: PluginFilePreview, path: string): boolean {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  return provider.extensions.some((extension) => {
    const suffix = `.${extension.toLowerCase()}`;
    return name.length > suffix.length && name.endsWith(suffix);
  });
}

export function previewKind(path: string) {
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path)) return "image";
  if (/\.(mp3|wav|ogg|opus|m4a|flac|aac)$/i.test(path)) return "audio";
  if (/\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(path)) return "video";
  if (/\.pdf$/i.test(path)) return "pdf";
  return "text";
}

/** Every range remains bounded, including PDF libraries' initial metadata reads. */
export async function readPreviewRange(
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > 1024 * 1024
  ) {
    throw new Error("Invalid preview range");
  }
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end - 1}` },
    signal,
    cache: "no-store",
    credentials: "omit",
  });
  if (response.status !== 206) throw new Error(`Preview request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== end - start) throw new Error("Preview file changed during reading");
  return bytes;
}
