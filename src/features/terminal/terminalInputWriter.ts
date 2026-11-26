import { bytesToBase64 } from "@/lib/text/base64";

// Stay below both native brokers' payload limits, including for UTF-8 paste.
const PACKET_BYTES = 16 * 1024;

/** One in-flight IPC per renderer. Coalesce bursts without delaying the first key,
 * and never retry an admitted write (it may already have reached the shell). */
export function createTerminalInputWriter(
  write: (data: string) => Promise<void>,
  failed: (error: unknown) => void,
) {
  const encoder = new TextEncoder();
  const pending: Uint8Array[] = [];
  let offset = 0;
  let running: Promise<void> | undefined;
  let disposed = false;
  let failure: { error: unknown } | undefined;
  const pump = () => {
    if (running || disposed || failure || !pending.length) return;
    const packet = new Uint8Array(PACKET_BYTES);
    let length = 0;
    while (pending.length && length < packet.length) {
      const first = pending[0]!;
      const count = Math.min(first.length - offset, packet.length - length);
      packet.set(first.subarray(offset, offset + count), length);
      length += count;
      offset += count;
      if (offset === first.length) {
        pending.shift();
        offset = 0;
      }
    }
    running = write(bytesToBase64(packet.subarray(0, length)))
      .catch((error: unknown) => {
        failure = { error };
        pending.length = 0;
        if (!disposed) failed(error);
      })
      .finally(() => {
        running = undefined;
        pump();
      });
  };
  return {
    push(data: string) {
      if (disposed || failure || !data) return;
      pending.push(encoder.encode(data));
      pump();
    },
    async drain() {
      while (running) await running;
      if (failure) throw failure.error;
    },
    dispose() {
      disposed = true;
      pending.length = 0;
    },
  };
}
