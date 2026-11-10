import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { emptyProcessSample, type ProcessConsumer, type ProcessSample } from "./model";

interface Consumer {
  paused: boolean;
  receive(): void;
}
interface Sampler {
  sample: ProcessSample;
  consumers: Set<Consumer>;
  generation: number;
  busy: boolean;
  queued: boolean;
  timer: number | undefined;
  stopListening(): void;
  tick(manual?: boolean): Promise<void>;
  schedule(immediate?: boolean): void;
}
// Keep retired pending transports until settlement; reopening cannot overlap them.
const samplers = new Map<string, Sampler>();
export const readProcessSample = (sessionId: string): ProcessSample =>
  samplers.get(sessionId)?.sample ?? emptyProcessSample;
const connected = (sessionId: string) =>
  useSsh.getState().sessions.some((session) => session.id === sessionId) &&
  !useSsh.getState().disconnectingSessionIds.includes(sessionId);
const interval = () => {
  const settings = useSettings.getState().settings;
  return Math.max(1000, settings.monitorIntervalMs, settings.lightweightMode ? 5000 : 0);
};
function createSampler(sessionId: string): Sampler {
  const publish = (sample: ProcessSample) => {
    next.sample = Object.freeze(sample);
    for (const consumer of [...next.consumers]) consumer.receive();
  };
  const automatic = () => [...next.consumers].some((consumer) => !consumer.paused);
  const visible = () => document.visibilityState === "visible";
  const next: Sampler = {
    sample: emptyProcessSample,
    consumers: new Set(),
    generation: 0,
    busy: false,
    queued: false,
    timer: undefined,
    stopListening: () => {},
    schedule(immediate = false) {
      window.clearTimeout(next.timer);
      if (!next.busy && automatic() && visible() && connected(sessionId))
        next.timer = window.setTimeout(() => void next.tick(), immediate ? 0 : interval());
    },
    async tick(manual = false) {
      if (!next.consumers.size || !visible() || !connected(sessionId)) return;
      if (!manual && !automatic()) return;
      if (next.busy) return;
      window.clearTimeout(next.timer);
      const generation = next.generation;
      next.busy = true;
      const current = () =>
        next.generation === generation && next.consumers.size > 0 && connected(sessionId);
      try {
        publish({ ...next.sample, loading: true });
        if (!current()) return;
        const items = await api.remoteProcesses(sessionId);
        if (current())
          publish({
            items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
            error: null,
            loading: false,
            updatedAt: Date.now(),
          });
      } catch (cause) {
        if (current()) publish({ ...next.sample, error: translateError(cause), loading: false });
      } finally {
        next.busy = false;
        if (!next.consumers.size) samplers.delete(sessionId);
        else if (next.queued) {
          next.queued = false;
          next.schedule(true);
        } else next.schedule();
      }
    },
  };
  return next;
}

/** One completion-based sampler per connection; each caller owns an independent lease. */
export function acquireProcessSampler(sessionId: string, receive: () => void): ProcessConsumer {
  let sampler = samplers.get(sessionId);
  if (!sampler) {
    sampler = createSampler(sessionId);
    samplers.set(sessionId, sampler);
  }
  const current = sampler;
  const consumer: Consumer = { paused: false, receive };
  const first = !current.consumers.size;
  const hadDemand = [...current.consumers].some((item) => !item.paused);
  current.consumers.add(consumer);
  if (first) {
    const visibility = () => current.schedule(true);
    const unsubscribe = useSettings.subscribe((state, previous) => {
      if (
        state.settings.monitorIntervalMs !== previous.settings.monitorIntervalMs ||
        state.settings.lightweightMode !== previous.settings.lightweightMode
      )
        current.schedule();
    });
    let alive = connected(sessionId);
    const disconnected = () => {
      window.clearTimeout(current.timer);
      current.generation += 1;
      current.sample = Object.freeze({
        ...emptyProcessSample,
        error: translateError(new Error("ssh.sessionMissing")),
      });
      for (const listener of [...current.consumers]) listener.receive();
    };
    if (!alive) disconnected();
    const unsubscribeSsh = useSsh.subscribe(() => {
      const nextAlive = connected(sessionId);
      if (alive === nextAlive) return;
      alive = nextAlive;
      if (!alive) disconnected();
      else if (current.busy) current.queued = true;
      else current.schedule(true);
    });
    document.addEventListener("visibilitychange", visibility);
    current.stopListening = () => {
      unsubscribe();
      unsubscribeSsh();
      document.removeEventListener("visibilitychange", visibility);
    };
    if (current.busy) current.queued = true;
    else current.schedule(true);
  }
  if (!first && !hadDemand) current.schedule(true);
  let released = false;
  const ready = () => !released && current.consumers.has(consumer);
  return {
    read: () => current.sample,
    refresh: () => {
      if (ready()) void current.tick(true);
    },
    setPaused: (paused) => {
      if (!ready() || consumer.paused === paused) return;
      consumer.paused = paused;
      current.schedule(!paused);
    },
    release: () => {
      if (!ready()) return;
      released = true;
      current.consumers.delete(consumer);
      if (current.consumers.size) {
        current.schedule();
        return;
      }
      window.clearTimeout(current.timer);
      current.stopListening();
      current.generation += 1;
      current.sample = emptyProcessSample;
      current.queued = false;
      if (!current.busy) samplers.delete(sessionId);
    },
  };
}
