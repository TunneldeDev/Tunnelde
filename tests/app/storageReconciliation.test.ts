import { beforeEach, expect, it, vi } from "vitest";
import type { StorageStatus } from "@/lib/api/storage";
import { reconcileStorageMetadata } from "@/app/plugins/storageReconciliation";
import { useStorage } from "@/store/storage";
import { useRestartPrompt } from "@/store/restartPrompt";

const mocks = vi.hoisted(() => ({ storageStatus: vi.fn(), storageRestartPending: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, isTauri: () => true }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const inventory: StorageStatus = {
  locations: [],
  pending: { id: "new-plan", changes: [] },
  previous: {},
  lastError: null,
};

beforeEach(() => {
  mocks.storageStatus.mockReset().mockResolvedValue(inventory);
  mocks.storageRestartPending.mockReset().mockResolvedValue(true);
  useStorage.setState({ status: null, restartPending: false, loading: false, busy: false });
  useRestartPrompt.getState().close();
});

it("restores a missed plan and its restart prompt without starting an inventory scan", async () => {
  await reconcileStorageMetadata(new AbortController().signal);
  expect(useStorage.getState().restartPending).toBe(true);
  expect(useRestartPrompt.getState().open).toBe(true);
  expect(mocks.storageStatus).not.toHaveBeenCalled();
});

it("replaces an invalidated first inventory even while its status is still null", async () => {
  const first = deferred<StorageStatus>();
  mocks.storageStatus.mockReturnValueOnce(first.promise);
  const initial = useStorage.getState().load();
  const recovery = reconcileStorageMetadata(new AbortController().signal);
  await Promise.resolve();
  first.resolve({ ...inventory, pending: null });
  await Promise.all([initial, recovery]);
  expect(mocks.storageStatus).toHaveBeenCalledTimes(2);
  expect(useStorage.getState().status).toEqual(inventory);
  expect(useStorage.getState().restartPending).toBe(true);
  expect(useStorage.getState().loading).toBe(false);
});

it("refreshes a requested inventory and closes a prompt after a missed cancellation", async () => {
  useStorage.setState({ status: inventory, restartPending: true });
  useRestartPrompt.getState().show();
  mocks.storageRestartPending.mockResolvedValue(false);
  mocks.storageStatus.mockResolvedValue({ ...inventory, pending: null });
  await reconcileStorageMetadata(new AbortController().signal);
  expect(mocks.storageStatus).toHaveBeenCalledOnce();
  expect(useStorage.getState().restartPending).toBe(false);
  expect(useStorage.getState().status?.pending).toBe(null);
  expect(useRestartPrompt.getState().open).toBe(false);
});

it("lets event recovery retry a failed authoritative metadata read", async () => {
  mocks.storageRestartPending.mockRejectedValueOnce(new Error("temporarily unavailable"));
  const lifetime = new AbortController();
  await expect(reconcileStorageMetadata(lifetime.signal)).rejects.toThrow(
    "temporarily unavailable",
  );
  expect(useRestartPrompt.getState().open).toBe(false);
  await reconcileStorageMetadata(lifetime.signal);
  expect(useStorage.getState().restartPending).toBe(true);
  expect(useRestartPrompt.getState().open).toBe(true);
});

it("does not read or change a prompt after its bridge lifetime has ended", async () => {
  const lifetime = new AbortController();
  lifetime.abort();
  await reconcileStorageMetadata(lifetime.signal);
  expect(mocks.storageRestartPending).not.toHaveBeenCalled();
  expect(mocks.storageStatus).not.toHaveBeenCalled();
  expect(useRestartPrompt.getState().open).toBe(false);
});

it("discards a metadata reply arriving after disposal and skips the inventory", async () => {
  const pending = deferred<boolean>();
  const lifetime = new AbortController();
  useStorage.setState({ status: { ...inventory, pending: null } });
  mocks.storageRestartPending.mockReturnValueOnce(pending.promise);
  const recovery = reconcileStorageMetadata(lifetime.signal);
  lifetime.abort();
  pending.resolve(true);
  await recovery;
  expect(useStorage.getState().restartPending).toBe(false);
  expect(useRestartPrompt.getState().open).toBe(false);
  expect(mocks.storageStatus).not.toHaveBeenCalled();
});
