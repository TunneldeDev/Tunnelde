import { useCallback, useEffect, useRef, useState } from "react";
import { runnerRecoveryApi as client } from "@/lib/api/runners/recovery";
import { translateError } from "@/lib/api/errors";
import type {
  RecoveryAction,
  RecoveryEntry,
  RecoveryObservation,
  RecoverySnapshot,
} from "@/lib/runners/recovery/contracts";

/** Mount per owner/page: responses from a closed page never reach its replacement. */
export function useRecoveryPage(pluginId: string, offset: number) {
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null);
  const [observations, setObservations] = useState<Record<string, RecoveryObservation>>({});
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false),
    lock = useRef(false),
    sequence = useRef(0);
  const run = useCallback(
    async (entry?: RecoveryEntry, action?: RecoveryAction) => {
      if (!active.current || lock.current) return;
      const serial = ++sequence.current;
      lock.current = true;
      setPending(true);
      setError(null);
      const current = () => active.current && sequence.current === serial;
      try {
        const result =
          entry && action ? await client.action({ pluginId, token: entry.token, action }) : null;
        if (!current() || (result && !result.accepted)) return;
        const next = await client.snapshot(pluginId, offset);
        if (!current()) return;
        setSnapshot(next);
        setObservations((previous) => {
          const kept = Object.fromEntries(
            Object.entries(previous).filter(([token]) =>
              next.entries.some((entry) => entry.token === token),
            ),
          );
          if (result?.observation) kept[result.observation.token] = result.observation;
          return kept;
        });
      } catch (error) {
        if (current()) setError(translateError(error));
      } finally {
        if (current()) {
          lock.current = false;
          setPending(false);
        }
      }
    },
    [pluginId, offset],
  );
  useEffect(() => {
    const serial = sequence;
    active.current = true;
    lock.current = true;
    const initial = ++sequence.current;
    const current = () => active.current && sequence.current === initial;
    void client
      .snapshot(pluginId, offset)
      .then((next) => {
        if (current()) {
          setSnapshot(next);
          setObservations({});
          setError(null);
        }
      })
      .catch((error) => {
        if (current()) setError(translateError(error));
      })
      .finally(() => {
        if (current()) {
          lock.current = false;
          setPending(false);
        }
      });
    return () => {
      active.current = false;
      lock.current = false;
      serial.current++;
    };
  }, [pluginId, offset]);
  return {
    snapshot,
    observations,
    pending,
    error,
    reload: () => run(),
    act: (entry: RecoveryEntry, action: RecoveryAction) => run(entry, action),
  };
}
