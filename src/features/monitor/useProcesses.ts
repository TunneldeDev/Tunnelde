import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { acquireProcessSampler, readProcessSample } from "./processes/runtime/sampling";
import { emptyProcessSample, type ProcessConsumer } from "./processes/runtime/model";

/** React owns a consumer, never a separate SSH polling loop. */
export function useProcesses(sessionId: string) {
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const lease = useRef<ProcessConsumer | null>(null);
  const subscribe = useCallback(
    (receive: () => void) => {
      const consumer = acquireProcessSampler(sessionId, receive);
      lease.current = consumer;
      consumer.setPaused(pausedRef.current);
      return () => {
        lease.current = null;
        consumer.release();
      };
    },
    [sessionId],
  );
  const read = useCallback(() => readProcessSample(sessionId), [sessionId]);
  const sample = useSyncExternalStore(subscribe, read, () => emptyProcessSample);
  const refresh = useCallback(() => lease.current?.refresh(), []);
  const setSamplingPaused = useCallback((value: boolean) => {
    pausedRef.current = value;
    setPaused(value);
    lease.current?.setPaused(value);
  }, []);
  const togglePaused = useCallback(
    () => setSamplingPaused(!pausedRef.current),
    [setSamplingPaused],
  );
  return {
    ...sample,
    paused,
    refresh,
    togglePaused,
    setPaused: setSamplingPaused,
  };
}
