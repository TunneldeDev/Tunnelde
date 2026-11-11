import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsProfile, SettingsProfilesSnapshot } from "@/lib/prefs/profiles";

const mocks = vi.hoisted(() => ({
  settingsProfilesSnapshot: vi.fn(),
  saveSettingsProfile: vi.fn(),
  deleteSettingsProfile: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, isTauri: () => true }));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/errors", () => ({ translateError: (error: unknown) => String(error) }));
const first: SettingsProfile = {
  id: "work",
  name: "Work",
  settings: { theme: "dark" },
  updatedAt: 1,
};
const fresh = async () => (await import("@/store/settingsProfiles")).useSettingsProfiles;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.resetModules();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.settingsProfilesSnapshot.mockResolvedValue({
    profiles: [first],
    revision: "pc1:first",
    activeId: "work",
  });
});

describe("settings profile persistence", () => {
  it("does not scan profile bodies on lifecycle recovery before the settings UI opens", async () => {
    const store = await fresh();
    await store.getState().refresh();
    expect(mocks.settingsProfilesSnapshot).not.toHaveBeenCalled();
    await store.getState().load();
    expect(store.getState().revision).toBe("pc1:first");
    expect(store.getState().selectedId).toBe("work");
  });

  it("coalesces change events during reads and rejects the superseded response", async () => {
    const store = await fresh();
    const pending = deferred<SettingsProfilesSnapshot>();
    mocks.settingsProfilesSnapshot.mockReturnValueOnce(pending.promise);
    const task = store.getState().load();
    void store.getState().refresh();
    void store.getState().refresh();
    pending.resolve({ profiles: [], activeId: null, revision: "old" });
    await task;
    expect(mocks.settingsProfilesSnapshot).toHaveBeenCalledTimes(2);
    expect(store.getState().profiles).toEqual([first]);
    expect(store.getState().selectedId).toBe("work");
  });

  it("queues an authoritative refresh after a mutation and rejects reads begun before it", async () => {
    const store = await fresh();
    await store.getState().load();
    const old = deferred<SettingsProfilesSnapshot>();
    const saving = deferred<SettingsProfile[]>();
    mocks.settingsProfilesSnapshot.mockReturnValueOnce(old.promise);
    mocks.saveSettingsProfile.mockReturnValueOnce(saving.promise);
    const loading = store.getState().load();
    const change = store.getState().save("work", "Renamed", first.settings);
    void store.getState().refresh();
    old.resolve({ profiles: [], revision: "old", activeId: null });
    await loading;
    expect(store.getState().selectedId).toBe("work");
    expect(store.getState().loading).toBe(false);
    const renamed = { ...first, name: "Renamed" };
    mocks.settingsProfilesSnapshot.mockResolvedValue({
      profiles: [renamed],
      revision: "new",
      activeId: "work",
    });
    saving.resolve([renamed]);
    expect(await change).toBe(true);
    await store.getState().load();
    expect(store.getState().profiles).toEqual([renamed]);
    expect(store.getState().revision).toBe("new");
  });

  it("keeps confirmed state on a refresh failure and can retry", async () => {
    const store = await fresh();
    await store.getState().load();
    mocks.settingsProfilesSnapshot.mockRejectedValueOnce(new Error("locked"));
    await store.getState().refresh();
    expect(store.getState().error).toContain("locked");
    expect(store.getState().revision).toBe("pc1:first");
    expect(store.getState().selectedId).toBe("work");
    await store.getState().load();
    expect(store.getState().error).toBeNull();
  });

  it("deduplicates loading and prevents a stale load from replacing a newly saved snapshot", async () => {
    const loading = deferred<SettingsProfilesSnapshot>();
    mocks.settingsProfilesSnapshot.mockReturnValueOnce(loading.promise);
    const store = await fresh();
    const task = store.getState().load();
    expect(store.getState().load()).toBe(task);
    expect(mocks.settingsProfilesSnapshot).toHaveBeenCalledOnce();
    const added = { ...first, id: "new", name: "New" };
    mocks.saveSettingsProfile.mockResolvedValue([first, added]);
    expect(await store.getState().save(null, " New ", { theme: "dark" })).toBe(true);
    mocks.settingsProfilesSnapshot.mockResolvedValue({
      profiles: [first, added],
      revision: "pc1:new",
      activeId: "work",
    });
    loading.resolve({ profiles: [first], revision: "pc1:old", activeId: null });
    await task;
    expect(store.getState().profiles).toEqual([first, added]);
    expect(store.getState().selectedId).toBe("work");
  });

  it("keeps confirmed snapshots and selection after a save or delete fails", async () => {
    const store = await fresh();
    await store.getState().load();
    mocks.saveSettingsProfile.mockRejectedValue(new Error("disk full"));
    expect(await store.getState().save("work", "Renamed", { theme: "light" })).toBe(false);
    expect(store.getState().profiles).toEqual([first]);
    expect(store.getState().selectedId).toBe("work");
    mocks.deleteSettingsProfile.mockRejectedValue(new Error("locked"));
    expect(await store.getState().remove("work")).toBe(false);
    expect(store.getState().profiles).toEqual([first]);
    expect(store.getState().selectedId).toBe("work");
    expect(store.getState().busy).toBe(false);
  });

  it("prevents overlapping mutations and preserves active selection when renaming another profile", async () => {
    const store = await fresh();
    await store.getState().load();
    const saving = deferred<SettingsProfile[]>();
    mocks.saveSettingsProfile.mockReturnValue(saving.promise);
    const task = store.getState().save("other", "Other", { theme: "light" });
    expect(await store.getState().remove("work")).toBe(false);
    expect(mocks.deleteSettingsProfile).not.toHaveBeenCalled();
    saving.resolve([first, { ...first, id: "other", name: "Other" }]);
    expect(await task).toBe(true);
    expect(store.getState().selectedId).toBe("work");
  });
});
