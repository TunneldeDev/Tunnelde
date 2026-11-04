export type Dispose = () => void;
export type Handler<T> = (payload: T) => void | Promise<void>;
export type EventTransport = (name: string, receive: Handler<unknown>) => Promise<Dispose>;

interface Channel {
  handlers: Map<symbol, { receive: Handler<unknown>; dispose: Dispose }>;
  ready: Promise<void>;
  stop?: Dispose;
}

/** One transport listener per event, without retaining event payloads or state. */
export function createEventBus<Events extends object>(
  transport: EventTransport,
  report: (name: string, error: unknown) => void = () => {},
) {
  const channels = new Map<string, Channel>();
  const failure = (name: string, error: unknown) => {
    try {
      report(name, error);
    } catch {
      /* Diagnostics must not stop delivery. */
    }
  };
  const dispose = (name: string, stop: Dispose) => {
    try {
      Promise.resolve(stop()).catch((error) => failure(name, error));
    } catch (error) {
      failure(name, error);
    }
  };
  const close = (name: string, channel: Channel) => {
    if (channels.get(name) === channel) channels.delete(name);
    const stop = channel.stop;
    channel.stop = undefined;
    if (stop) dispose(name, stop);
  };

  return {
    async on<K extends keyof Events & string>(
      name: K,
      handler: Handler<Events[K]>,
      signal?: AbortSignal,
    ): Promise<Dispose> {
      if (signal?.aborted) return () => {};
      let channel = channels.get(name);
      const initialize = !channel;
      if (!channel) {
        channel = { handlers: new Map(), ready: Promise.resolve() };
        channels.set(name, channel);
      }
      const key = Symbol(name);
      const current = channel;
      let active = true;
      const stop = () => {
        if (!active) return;
        active = false;
        signal?.removeEventListener("abort", stop);
        current.handlers.delete(key);
        if (current.handlers.size === 0) close(name, current);
      };
      current.handlers.set(key, { receive: handler as Handler<unknown>, dispose: stop });
      signal?.addEventListener("abort", stop, { once: true });
      if (initialize) {
        // Start synchronous transports immediately, after the subscriber has been attached.
        try {
          current.ready = Promise.resolve(
            transport(name, (payload) => {
              if (channels.get(name) !== current) return;
              for (const [key, subscriber] of [...current.handlers]) {
                if (!current.handlers.has(key)) continue;
                try {
                  Promise.resolve(subscriber.receive(payload)).catch((error) =>
                    failure(name, error),
                  );
                } catch (error) {
                  failure(name, error);
                }
              }
            }),
          ).then((unlisten) => {
            current.stop = unlisten;
            if (channels.get(name) !== current || current.handlers.size === 0) close(name, current);
          });
        } catch (error) {
          current.ready = Promise.reject(error);
        }
      }
      try {
        await current.ready;
      } catch (error) {
        stop();
        if (!signal?.aborted) throw error;
      }
      return stop;
    },
    dispose() {
      for (const [name, channel] of channels) {
        for (const subscriber of [...channel.handlers.values()]) subscriber.dispose();
        close(name, channel);
      }
    },
    diagnostics() {
      return [...channels].map(([name, channel]) => ({
        name,
        subscribers: channel.handlers.size,
        registered: !!channel.stop,
      }));
    },
  };
}

/** All-or-nothing registration, with idempotent start and an abortable lifetime. */
export function createSubscriptionGroup(
  registrations: Array<(signal: AbortSignal) => Promise<Dispose>>,
  report: (error: unknown) => void = () => {},
) {
  interface Lifetime {
    controller: AbortController;
    ready: Promise<void>;
    stops: Dispose[];
  }
  let lifetime: Lifetime | undefined;
  const safelyStop = (stop: Dispose) => {
    try {
      stop();
    } catch (error) {
      try {
        report(error);
      } catch {
        /* Continue releasing the remaining listeners. */
      }
    }
  };
  const release = (current: Lifetime) => {
    current.controller.abort();
    current.stops.splice(0).forEach(safelyStop);
    if (lifetime === current) lifetime = undefined;
  };
  return {
    start(): Promise<void> {
      if (lifetime) return lifetime.ready;
      const current: Lifetime = {
        controller: new AbortController(),
        ready: Promise.resolve(),
        stops: [],
      };
      lifetime = current;
      current.ready = Promise.all(
        registrations.map((register) =>
          Promise.resolve()
            .then(() => register(current.controller.signal))
            .then((stop) => {
              if (current.controller.signal.aborted) safelyStop(stop);
              else current.stops.push(stop);
            }),
        ),
      ).then(
        () => {},
        (error) => {
          const cancelled = current.controller.signal.aborted;
          release(current);
          if (!cancelled) throw error;
        },
      );
      return current.ready;
    },
    dispose() {
      if (lifetime) release(lifetime);
    },
  };
}
