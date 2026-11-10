import type { RemoteProcess } from "@/lib/api/types";

export interface ProcessSample {
  readonly items: readonly RemoteProcess[] | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly updatedAt: number | null;
}
export const emptyProcessSample: ProcessSample = Object.freeze({
  items: null,
  error: null,
  loading: false,
  updatedAt: null,
});
export interface ProcessConsumer {
  read(): ProcessSample;
  refresh(): void;
  setPaused(paused: boolean): void;
  release(): void;
}
