import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsProfile } from "@/lib/prefs/profiles";

const mocks = vi.hoisted(() => ({
  settingsProfiles: vi.fn(),
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
  mocks.settingsProfiles.mockResolvedValue([first]);
});

describe("settings profile persistence", () => {
  it("deduplicates loading and prevents a stale load from replacing a newly saved snapshot", async () => {
    const loading = deferred<SettingsProfile[]>();
    mocks.settingsProfiles.mockReturnValue(loading.promise);
    const store = await fresh();
    const task = store.getState().load();
    expect(store.getState().load()).toBe(task);
    expect(mocks.settingsProfiles).toHaveBeenCalledOnce();
    const added = { ...first, id: "new", name: "New" };
    mocks.saveSettingsProfile.mockResolvedValue([first, added]);
    expect(await store.getState().save(null, " New ", { theme: "dark" })).toBe(true);
    loading.resolve([first]);
    await task;
    expect(store.getState().profiles).toEqual([first, added]);
    expect(store.getState().selectedId).toBe("new");
  });

  it("keeps confirmed snapshots and selection after a save or delete fails", async () => {
    const store = await fresh();
    await store.getState().load();
    store.getState().select("work");
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
    store.getState().select("work");
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
