import type { QuickAccessResult } from "@/features/quickAccess/data/model";
import type { FrontendQuickAccessEntry } from "../../contracts/search/quickAccess/entry";

/** Public rows never contain executable closures, credentials or a live host store. */
export function projectQuickAccess(items: readonly QuickAccessResult[]) {
  return Object.freeze(
    items.map((item, index): Readonly<FrontendQuickAccessEntry> => {
      const kind = /^host\.(connect|open)\./.test(item.id)
        ? "host"
        : item.id.startsWith("tab:")
          ? "tab"
          : item.id.startsWith("file:")
            ? "file"
            : "command";
      const commandId = kind === "command" ? item.id : null;
      return Object.freeze({
        key: `result:${index}`,
        kind,
        title: item.title.slice(0, 1024),
        detail: item.detail?.slice(0, 2048) ?? null,
        fileName: item.fileName?.slice(0, 512) ?? null,
        filePath: item.filePath?.slice(0, 2048) ?? null,
        commandId: commandId?.slice(0, 512) ?? null,
        truncated:
          item.title.length > 1024 ||
          (item.detail?.length ?? 0) > 2048 ||
          (item.fileName?.length ?? 0) > 512 ||
          (item.filePath?.length ?? 0) > 2048 ||
          (commandId?.length ?? 0) > 512,
      });
    }),
  );
}
