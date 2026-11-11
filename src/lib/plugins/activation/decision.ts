/** A shared consent decision with independently cancellable callers. */
export class ActivationDecision {
  readonly promise: Promise<boolean>;
  private complete!: (allowed: boolean) => void;
  private settled = false;
  private retained = false;
  private readonly callers = new Set<(allowed: boolean) => void>();

  constructor(private readonly onFinish: () => void) {
    this.promise = new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  get active() {
    return !this.settled;
  }

  finish(allowed: boolean) {
    if (this.settled) return;
    this.settled = true;
    this.onFinish();
    this.complete(allowed);
    for (const resolve of this.callers) resolve(allowed);
    this.callers.clear();
  }

  wait(signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      this.retained = true;
      return this.promise;
    }
    if (signal.aborted) return Promise.resolve(false);
    if (this.settled) return this.promise;
    return new Promise((resolve) => {
      const finish = (allowed: boolean) => {
        signal.removeEventListener("abort", abort);
        this.callers.delete(finish);
        resolve(allowed);
      };
      const abort = () => {
        finish(false);
        if (!this.retained && this.callers.size === 0) this.finish(false);
      };
      this.callers.add(finish);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
