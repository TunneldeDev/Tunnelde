import type { RecoveryPageServices } from "../data/services";
import { useCallback, useEffect, useRef, useState } from "react";
import { translateError } from "@/lib/api/errors";
import type {
  RecoveryAction,
  RecoveryCapabilityObservation,
  RecoveryEntry,
  RecoveryObservation,
  RecoverySnapshot,
} from "@/lib/runners/recovery/contracts";

/** Mount per owner/page: responses from a closed page never reach its replacement. */
export function useRecoveryPageModel(
  pluginId: string,
  offset: number,
  services: RecoveryPageServices,
) {
  const { client, useViewState, useBusyGuard } = services;
  const key = `recovery:${pluginId}:${offset}`;
  const [snapshot, setSnapshot] = useViewState<RecoverySnapshot | null>(`${key}:snapshot`, null);
  const [observations, setObservations] = useViewState<Record<string, RecoveryObservation>>(
    `${key}:observations`,
    {},
  );
  const [capabilities, setCapabilities] = useViewState<
    Record<string, RecoveryCapabilityObservation>
  >(`${key}:capabilities`, {});
  const [pending, setPending] = useState(true);
  const [error, setError] = useViewState<string | null>(`${key}:error`, null);
  useBusyGuard(pending);
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
          if (
            result?.observation &&
            next.entries.some((entry) => entry.token === result.observation?.token)
          )
            kept[result.observation.token] = result.observation;
          return kept;
        });
        setCapabilities((previous) => {
          const kept = Object.fromEntries(
            Object.entries(previous).filter(([token]) =>
              next.entries.some((entry) => entry.token === token),
            ),
          );
          if (
            result?.capabilities &&
            next.entries.some((entry) => entry.token === result.capabilities?.token)
          )
            kept[result.capabilities.token] = result.capabilities;
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
    [pluginId, offset, client, setSnapshot, setObservations, setCapabilities, setError],
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
          // Keep only token-qualified observations for records that still exist.
          setObservations((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(([token]) =>
                next.entries.some((entry) => entry.token === token),
              ),
            ),
          );
          setCapabilities((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(([token]) =>
                next.entries.some((entry) => entry.token === token),
              ),
            ),
          );
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
  }, [pluginId, offset, client, setSnapshot, setObservations, setCapabilities, setError]);
  return {
    snapshot,
    observations,
    capabilities,
    pending,
    error,
    reload: () => run(),
    act: (entry: RecoveryEntry, action: RecoveryAction) => run(entry, action),
  };
}
