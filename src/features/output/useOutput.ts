import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createOutputSource, useOutputSource } from "./source";

export function useOutput(active: boolean) {
  const shared = useOutputSource((state) => state.source);
  const [local] = useState(createOutputSource);
  const source = shared ?? local;
  const content = useStore(source.store);
  useEffect(() => (active ? source.retain() : undefined), [source, active]);
  // StrictMode effect replay must not permanently dispose a retained controller.
  // No reader means no polling; late in-flight replies remain bounded in memory.
  return { ...content, refresh: source.refresh, clear: source.clear };
}
