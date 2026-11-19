import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createKnownHostsSource,
  installKnownHostsSource,
  useKnownHostsSource,
} from "@/features/settings/knownHosts/source";
const mock = vi.hoisted(() => ({ knownHostsList: vi.fn(), knownHostsForget: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: mock }));
const entry = {
  host: "qa.example",
  port: 22,
  algorithm: "ed25519",
  fingerprint: "SHA256:one",
  updatedAt: 7,
};
const cleanups: (() => void)[] = [];
beforeEach(() => {
  mock.knownHostsList.mockReset().mockResolvedValue([entry]);
  mock.knownHostsForget.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});
const source = () => {
  const s = createKnownHostsSource();
  cleanups.push(s.dispose);
  return s;
};
it("coalesces concurrent reads and shares demand without per-view native readers", async () => {
  const s = source();
  mock.knownHostsList.mockResolvedValueOnce([
    { ...entry, credential: "never-project", privatePath: "never-project" },
  ]);
  const first = s.retain(),
    second = s.retain();
  await s.refresh();
  expect(mock.knownHostsList).toHaveBeenCalledOnce();
  expect(s.store.getState()).toEqual({ entries: [entry], loading: false, error: "" });
  first();
  second();
  const third = s.retain();
  await s.refresh();
  third();
  expect(mock.knownHostsList).toHaveBeenCalledTimes(2);
});
it("cannot resurrect a deleted key from an older in-flight list, and sends the confirmed identity", async () => {
  const s = source();
  let resolve!: (value: (typeof entry)[]) => void;
  mock.knownHostsList.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const old = s.refresh();
  await Promise.resolve();
  mock.knownHostsList.mockResolvedValue([]);
  await s.forget(entry);
  await s.refresh();
  expect(mock.knownHostsForget).toHaveBeenCalledExactlyOnceWith(entry.host, entry.port, entry);
  resolve([entry]);
  await old;
  expect(s.store.getState()).toEqual({ entries: [], loading: false, error: "" });
});
it("preserves data on failed removal, and exposes retryable list errors without undoing successful removal", async () => {
  const s = source();
  await s.refresh();
  mock.knownHostsForget.mockRejectedValueOnce(new Error("changed"));
  await expect(s.forget(entry)).rejects.toThrow("changed");
  expect(s.store.getState().entries).toEqual([entry]);
  mock.knownHostsList.mockRejectedValueOnce(new Error("list unavailable"));
  await expect(s.forget(entry)).resolves.toBeUndefined();
  // Background read failure is independent from the committed deletion.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(s.store.getState()).toEqual({ entries: [], loading: false, error: "list unavailable" });
  mock.knownHostsList.mockResolvedValue([]);
  await s.refresh();
  expect(s.store.getState().error).toBe("");
});
it("ignores late disposed replies and an old uninstall never removes its replacement", async () => {
  const first = source(),
    second = source();
  const uninstall = installKnownHostsSource(first);
  cleanups.push(installKnownHostsSource(second));
  uninstall();
  expect(useKnownHostsSource.getState().source).toBe(second);
  let resolve!: (value: (typeof entry)[]) => void;
  mock.knownHostsList.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = first.refresh();
  await Promise.resolve();
  first.dispose();
  resolve([entry]);
  await pending;
  expect(first.store.getState().entries).toEqual([]);
  await expect(first.refresh()).rejects.toThrow("disposed");
  await expect(first.forget(entry)).rejects.toThrow("disposed");
});
