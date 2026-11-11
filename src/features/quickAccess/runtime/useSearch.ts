import { useEffect, useState } from "react";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { SearchQuery } from "@/lib/search/query";
import type { QuickAccessMode } from "../data/query";
import type { SearchResult } from "../data/model";
export function useQuickAccessSearch(
  mode: QuickAccessMode,
  path: string | undefined,
  sessionId: string | null,
  needle: string,
  searchKey: string,
  canSearch: boolean,
  selection: SearchQuery | undefined,
  resetSelection: (index: number) => void,
) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (!["files", "content"].includes(mode) || !path || !canSearch) return;
    let disposed = false;
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      setPendingKey(searchKey);
      setFailure(null);
      void api
        .filesSearch(
          requestId,
          sessionId,
          path,
          needle,
          mode === "content",
          ...(selection ? ([selection] as const) : []),
        )
        .then((response) => {
          if (!disposed) {
            setResult({ ...response, key: searchKey });
            resetSelection(0);
          }
        })
        .catch((cause) => {
          if (!disposed) setFailure({ key: searchKey, message: translateError(cause) });
        })
        .finally(() => {
          if (!disposed) setPendingKey(null);
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void api.filesSearchCancel(requestId).catch(() => {});
    };
  }, [mode, needle, path, sessionId, searchKey, canSearch, selection, resetSelection]);
  return {
    result,
    searching: pendingKey === searchKey,
    error: failure?.key === searchKey ? failure.message : "",
    setFailure,
  };
}
