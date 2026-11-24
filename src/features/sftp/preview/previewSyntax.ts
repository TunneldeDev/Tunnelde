import { useMemo } from "react";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { syntaxProviders } from "@/lib/plugins/syntax";
import { runSyntaxHighlighting } from "@/lib/plugins/syntaxRunner";
import type { PreviewFile } from "@/store/filePreview";
import type { PreviewReadSource } from "./readSource";
import type { PreviewSyntaxSource } from "./usePreviewSyntax";

function providerFor(
  path: string,
  {
    items,
    stoppingIds,
  }: Pick<ReturnType<typeof usePlugins.getState>, "items" | "stoppingIds"> = usePlugins.getState(),
  security = usePluginSecurity.getState().state,
) {
  if (security.restricted) return null;
  const provider = syntaxProviders(path, items).find((candidate) => {
    const plugin = items.find((item) => item.id === candidate.id);
    return (
      plugin?.status === "running" &&
      !stoppingIds.includes(plugin.id) &&
      plugin.permissions.includes("editor.read") &&
      plugin.permissions.every((permission) => security.grants[plugin.id]?.includes(permission))
    );
  });
  if (!provider) return null;
  const plugin = items.find((item) => item.id === provider.id)!;
  return {
    provider,
    key: JSON.stringify([
      provider,
      plugin.version,
      plugin.runtime,
      plugin.runtimeId,
      plugin.fingerprint,
      plugin.permissions,
    ]),
  };
}

/** Display invalidation only. This key conveys no execution authority. */
export const previewSyntaxKey = (path: string): string | null => providerFor(path)?.key ?? null;

export function previewSyntaxSource(
  path: string,
  source: PreviewReadSource,
  isCurrent: () => boolean = () => true,
): PreviewSyntaxSource | undefined {
  const selected = providerFor(path);
  if (!selected) return;
  return {
    key: selected.key,
    async highlight(document, range, signal) {
      const read = source.snapshot();
      const current = () =>
        !signal.aborted &&
        isCurrent() &&
        document.path === path &&
        source.snapshot() === read &&
        read.status === "ready" &&
        read.value.content === document.content &&
        previewSyntaxKey(path) === selected.key;
      if (!current()) return null;
      return runSyntaxHighlighting(
        {
          provider: selected.provider,
          document,
          window: { offset: range.from, length: range.to - range.from },
          inlineWindow: true,
          isCurrent: current,
        },
        signal,
      );
    },
  };
}

/** Main-window adapter; detached renderers receive a lease-scoped source instead. */
export function usePreviewSyntaxSource(file: PreviewFile, source: PreviewReadSource) {
  const items = usePlugins((state) => state.items);
  const stoppingIds = usePlugins((state) => state.stoppingIds);
  const security = usePluginSecurity((state) => state.state);
  const key = providerFor(file.path, { items, stoppingIds }, security)?.key;
  return useMemo(
    () => (key ? previewSyntaxSource(file.path, source) : undefined),
    [file.path, source, key],
  );
}
