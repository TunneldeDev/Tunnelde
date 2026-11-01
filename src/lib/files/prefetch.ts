export interface PrefetchJob<T> {
  key: string;
  read: () => Promise<T>;
  commit: (value: T) => void;
}

interface Task<T> extends PrefetchJob<T> {
  owner: string;
  version: number;
  generation: number;
  keyVersion: number;
}

/** A shared bounded queue for both panels, with foreground reads taking priority. */
export function createPrefetchQueue<T>(options: {
  enabled: () => boolean;
  cached: (key: string) => boolean;
  concurrency?: number;
}) {
  const owners = new Map<string, number>();
  const keys = new Map<string, number>();
  const foreground = new Map<string, number>();
  const running = new Set<Task<T>>();
  let pending: Task<T>[] = [];
  let generation = 0;
  const current = (task: Task<T>) =>
    task.generation === generation &&
    task.version === owners.get(task.owner) &&
    task.keyVersion === (keys.get(task.key) ?? 0);

  const drain = () => {
    if (!options.enabled() || foreground.size > 0) return;
    pending = pending.filter((task) => current(task) && !options.cached(task.key));
    while (running.size < (options.concurrency ?? 2) && pending.length) {
      const index = pending.findIndex(
        (task) => ![...running].some((active) => current(active) && active.key === task.key),
      );
      if (index < 0) break;
      const [task] = pending.splice(index, 1);
      if (!task) break;
      running.add(task);
      void Promise.resolve()
        .then(task.read)
        .then((value) => {
          if (current(task) && options.enabled()) task.commit(value);
        })
        .catch(() => undefined)
        .finally(() => {
          running.delete(task);
          drain();
        });
    }
  };

  const clearOwner = (owner: string) => {
    const version = (owners.get(owner) ?? 0) + 1;
    owners.set(owner, version);
    pending = pending.filter((task) => task.owner !== owner);
    return version;
  };

  return {
    replace(owner: string, jobs: PrefetchJob<T>[]) {
      const version = clearOwner(owner);
      const seen = new Set<string>();
      for (const job of jobs) {
        if (options.cached(job.key) || seen.has(job.key)) continue;
        seen.add(job.key);
        pending.push({ ...job, owner, version, generation, keyVersion: keys.get(job.key) ?? 0 });
      }
      drain();
    },
    foreground(owner: string, key?: string) {
      const version = clearOwner(owner);
      foreground.set(owner, version);
      if (key) {
        keys.set(key, (keys.get(key) ?? 0) + 1);
        pending = pending.filter((task) => task.key !== key);
      }
      return () => {
        if (foreground.get(owner) === version) foreground.delete(owner);
        drain();
      };
    },
    invalidate() {
      generation++;
      pending = [];
      keys.clear();
    },
  };
}
