import { useCallback, useEffect, useRef, useState } from "react";
import { api, isTauri, type OutputCursor } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { boundOutput, snapshotEntries, type OutputEntry } from "./model";

export function useOutput(active: boolean) {
  const [content, setContent] = useState<{ entries: OutputEntry[]; truncated: boolean }>({
    entries: [],
    truncated: false,
  });
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const cursor = useRef<OutputCursor | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const clearSerial = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!active || !isTauri()) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      // An earlier IPC may still be finishing after a visibility change.
      if (!disposed && !document.hidden && !inFlight.current) {
        inFlight.current = true;
        const serial = clearSerial.current;
        try {
          const result = await api.logsOutputRead(cursor.current);
          if (!disposed) {
            cursor.current = result.cursor;
            const added = snapshotEntries(result, () => ++sequence.current);
            setContent((previous) => {
              if (serial !== clearSerial.current) return previous;
              const bounded = boundOutput([...previous.entries, ...added]);
              return added.length || result.truncated
                ? {
                    entries: bounded.entries,
                    truncated: previous.truncated || bounded.omitted || result.truncated,
                  }
                : previous;
            });
            setError("");
          }
        } catch (cause) {
          if (!disposed) setError(translateError(cause));
        } finally {
          inFlight.current = false;
        }
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [active, revision]);

  const clear = () => {
    clearSerial.current++;
    setContent({ entries: [], truncated: false });
  };
  return { ...content, error, refresh, clear };
}
