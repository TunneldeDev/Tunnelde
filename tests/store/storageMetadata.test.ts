import { beforeEach, expect, it, vi } from "vitest";
import { useStorage } from "@/store/storage";
const mocks = vi.hoisted(() => ({ storageStatus: vi.fn(), storageRestartPending: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, isTauri: () => true }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  mocks.storageStatus.mockReset();
  mocks.storageRestartPending.mockReset();
  useStorage.setState({
    status: null,
    restartPending: false,
    loading: false,
    busy: false,
    error: null,
  });
});

it("a simultaneous restart-status read preserves the initial settings inventory load", async () => {
  const pending = deferred<unknown>();
  mocks.storageStatus.mockReturnValue(pending.promise);
  mocks.storageRestartPending.mockResolvedValue(false);
  const load = useStorage.getState().load();
  await useStorage.getState().loadRestartPending();
  pending.resolve({ locations: [], pending: null });
  await load;
  expect(useStorage.getState().status).toEqual({ locations: [], pending: null });
});

it("late restart-status replies cannot replace a newer metadata read", async () => {
  const old = deferred<boolean>();
  mocks.storageRestartPending.mockReturnValueOnce(old.promise).mockResolvedValueOnce(true);
  const earlier = useStorage.getState().loadRestartPending();
  await useStorage.getState().loadRestartPending();
  old.resolve(false);
  await earlier;
  expect(useStorage.getState().restartPending).toBe(true);
});

it("a plugin metadata invalidation fences an already-running old inventory", async () => {
  const old = deferred<unknown>();
  mocks.storageStatus
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ locations: [], pending: { id: "new" } });
  mocks.storageRestartPending.mockResolvedValue(true);
  const earlier = useStorage.getState().load();
  await useStorage.getState().refreshMetadata();
  old.resolve({ locations: [], pending: null });
  await earlier;
  expect(useStorage.getState().status).toBe(null);
  expect(useStorage.getState().restartPending).toBe(true);
  await useStorage.getState().load();
  expect(useStorage.getState().status?.pending).toEqual({ id: "new" });
});
