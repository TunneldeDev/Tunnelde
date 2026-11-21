import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOutputSource,
  installOutputSource,
  useOutputSource,
  type OutputSource,
} from "@/features/output/source";
const api = vi.hoisted(() => ({ logsOutputRead: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
const snapshot = (diagnostic = "log line") => ({
  diagnostic,
  operations: [],
  truncated: false,
  cursor: { filename: "log", offset: 1, operationId: 0 },
});
const sources: OutputSource[] = [];
const source = () => {
  const s = createOutputSource();
  sources.push(s);
  return s;
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  api.logsOutputRead.mockReset().mockResolvedValue(snapshot());
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => {
  sources.splice(0).forEach((s) => s.dispose());
  useOutputSource.setState({ source: null });
  vi.useRealTimers();
});
it("keeps one cursor/reader across local and hidden-coordinator remote consumers", async () => {
  const s = source(),
    releaseLocal = s.retain();
  await flush();
  expect(api.logsOutputRead).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  api.logsOutputRead.mockResolvedValue(snapshot("remote line"));
  const releaseRemote = s.retain(true);
  releaseLocal();
  await flush();
  expect(api.logsOutputRead).toHaveBeenCalledTimes(2);
  expect(api.logsOutputRead).toHaveBeenLastCalledWith(snapshot().cursor);
  expect(s.store.getState().entries.map((e) => e.message)).toEqual(["log line", "remote line"]);
  releaseRemote();
  await vi.advanceTimersByTimeAsync(6000);
  expect(api.logsOutputRead).toHaveBeenCalledTimes(2);
});
it("pauses hidden local readers but resumes the same cursor without duplicating content", async () => {
  const s = source();
  s.retain();
  await flush();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await vi.advanceTimersByTimeAsync(6000);
  expect(api.logsOutputRead).toHaveBeenCalledTimes(1);
  // A skipped hidden poll must keep scheduling, otherwise visibility can strand it.
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.logsOutputRead).toHaveBeenCalledTimes(2);
});
it("never overlaps reads; clearing while a read is pending does not resurrect displayed rows", async () => {
  const s = source();
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  api.logsOutputRead.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  s.retain();
  await flush();
  const refreshed = s.refresh();
  expect(api.logsOutputRead).toHaveBeenCalledTimes(1);
  s.clear();
  resolve(snapshot("old in-flight output"));
  await refreshed;
  await flush();
  expect(s.store.getState().entries).toEqual([]);
  api.logsOutputRead.mockResolvedValue(snapshot("new output"));
  await vi.advanceTimersByTimeAsync(1);
  expect(api.logsOutputRead).toHaveBeenCalledTimes(2);
  expect(s.store.getState().entries[0]?.message).toBe("new output");
});
it("keeps read errors visible and recovers through the same singleton refresh", async () => {
  const s = source();
  api.logsOutputRead.mockRejectedValueOnce(new Error("read failed"));
  s.retain();
  await flush();
  expect(s.store.getState().error).toBeTruthy();
  await s.refresh();
  expect(s.store.getState().error).toBe("");
});
it("ignores late disposed replies and old uninstalls cannot revoke the replacement source", async () => {
  const old = source(),
    current = source();
  const stopOld = installOutputSource(old),
    stopCurrent = installOutputSource(current);
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  api.logsOutputRead.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  old.retain();
  await flush();
  old.dispose();
  stopOld();
  expect(useOutputSource.getState().source).toBe(current);
  resolve(snapshot());
  await flush();
  expect(old.store.getState().entries).toEqual([]);
  stopCurrent();
  expect(useOutputSource.getState().source).toBeNull();
});

it("keeps only one wake-up timer when a hidden refresh races a pending read", async () => {
  const s = source();
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  api.logsOutputRead.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  s.retain();
  await flush();
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  await s.refresh();
  expect(vi.getTimerCount()).toBe(1);
  resolve(snapshot());
  await flush();
  expect(vi.getTimerCount()).toBe(1);
  s.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
