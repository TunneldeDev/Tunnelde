import { beforeEach, expect, it, vi } from "vitest";
import { useStorage } from "@/store/storage";
import { useRestartPrompt } from "@/store/restartPrompt";
import type { StorageRestartPlan } from "@/lib/api/storage";
const mocks = vi.hoisted(() => ({ storageStatus: vi.fn(), storageRestartPlan: vi.fn() }));
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
  mocks.storageRestartPlan.mockReset();
  useRestartPrompt.setState({ open: false, observed: null });
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
  mocks.storageRestartPlan.mockResolvedValue(null);
  const load = useStorage.getState().load();
  await useStorage.getState().loadRestartPending();
  pending.resolve({ locations: [], pending: null });
  await load;
  expect(useStorage.getState().status).toEqual({ locations: [], pending: null });
});

it("late restart-status replies cannot replace a newer metadata read", async () => {
  const old = deferred<StorageRestartPlan | null>();
  mocks.storageRestartPlan
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ id: "new", action: "apply", restartRequested: false });
  const earlier = useStorage.getState().loadRestartPending();
  await useStorage.getState().loadRestartPending();
  old.resolve(null);
  await earlier;
  expect(useStorage.getState().restartPending).toBe(true);
});

it("a plugin metadata invalidation fences an already-running old inventory", async () => {
  const old = deferred<unknown>();
  mocks.storageStatus
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ locations: [], pending: { id: "new" } });
  mocks.storageRestartPlan.mockResolvedValue({
    id: "new",
    action: "apply",
    restartRequested: false,
  });
  const earlier = useStorage.getState().load();
  await useStorage.getState().refreshMetadata();
  old.resolve({ locations: [], pending: null });
  await earlier;
  expect(useStorage.getState().status).toBe(null);
  expect(useStorage.getState().restartPending).toBe(true);
  await useStorage.getState().load();
  expect(useStorage.getState().status?.pending).toEqual({ id: "new" });
});
