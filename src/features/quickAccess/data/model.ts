import type { api } from "@/lib/api/ipc";
import { fileName } from "@/store/editors";
import { searchText } from "@/lib/search/query";
export interface QuickAccessResult {
  id: string;
  title: string;
  detail?: string;
  fileName?: string;
  filePath?: string;
  run(): void;
}
export type Match = Awaited<ReturnType<typeof api.filesSearch>>["matches"][number];
export interface SearchResult {
  key: string;
  matches: Match[];
  limited: boolean;
  skipped: number;
}
export function fileSearchFields(path: string, name = fileName(path)) {
  const dot = name.lastIndexOf(".");
  return {
    name: (value: string) => searchText(name).includes(value),
    ext: dot > 0 ? name.slice(dot + 1) : "",
    path: (value: string) => searchText(path).includes(value),
  };
}
export interface QuickAccessCollection {
  items: QuickAccessResult[];
  limited: boolean;
}
