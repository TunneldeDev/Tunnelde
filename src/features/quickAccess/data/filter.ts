import type { Host } from "@/lib/api/types";
import type { ShortcutCommand } from "@/lib/keyboard/registry";
import {
  matchesSearch,
  matchesSearchNumber,
  searchText,
  type SearchQuery,
} from "@/lib/search/query";
import type { QuickAccessMode } from "./query";
import { fileSearchFields, type QuickAccessResult } from "./model";
export function filterQuickAccessResults(
  commands: QuickAccessResult[],
  parsedQuery: SearchQuery,
  mode: QuickAccessMode,
  hosts: readonly Host[],
  definitions: readonly ShortcutCommand[],
) {
  return commands.filter((command) => {
    const host =
      mode === "hosts"
        ? hosts.find(
            (host) =>
              command.id === `host.connect.${host.id}` || command.id === `host.open.${host.id}`,
          )
        : null;
    return matchesSearch(
      mode === "content" ? { ...parsedQuery, text: [] } : parsedQuery,
      `${command.title} ${command.detail ?? ""} ${command.id}`,
      {
        id: command.id,
        category: command.detail?.replace(/^Category: /, ""),
        plugin: definitions.find((item) => item.id === command.id)?.plugin?.id,
        name: (value) =>
          searchText(host?.name ?? command.fileName ?? command.title).includes(value),
        host: (value) => !!host && searchText(host.host).includes(value),
        user: host?.username,
        tag: host?.tags,
        is: host?.favorite ? ["favorite"] : [],
        port: (value) => matchesSearchNumber(host?.port, value),
        ext: fileSearchFields(command.filePath ?? "", command.fileName ?? "").ext,
        path: (value) => !!command.filePath && searchText(command.filePath).includes(value),
      },
    );
  });
}
