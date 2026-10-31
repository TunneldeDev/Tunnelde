// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppInfo, Settings } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  appInfo: vi.fn(),
  updateSettings: vi.fn(),
  resetSettings: vi.fn(),
  setLocale: vi.fn(),
  setLanguage: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api: mocks, isTauri: () => true }));
vi.mock("@/i18n/i18n", () => ({
  default: { t: (key: string) => key },
  setLanguage: mocks.setLanguage,
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/errors", () => ({ translateError: (error: unknown) => String(error) }));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const info = { systemLanguages: ["zh-CN"], os: "windows" } as AppInfo;
const fresh = async () => (await import("@/store/settings")).useSettings;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.settings.mockResolvedValue(DEFAULT_SETTINGS);
  mocks.appInfo.mockResolvedValue(info);
  mocks.setLocale.mockResolvedValue(undefined);
  mocks.resetSettings.mockResolvedValue(DEFAULT_SETTINGS);
  let persisted = { ...DEFAULT_SETTINGS };
  mocks.updateSettings.mockImplementation(
    async (patch) => (persisted = { ...persisted, ...patch }),
  );
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
});

describe("settings persistence", () => {
  it("prioritizes the native OS language over the WebView language", async () => {
    const store = await fresh();
    await store.getState().load();
    expect(mocks.setLanguage).toHaveBeenLastCalledWith("zh-CN");
    expect(mocks.setLocale).toHaveBeenLastCalledWith("zh-CN");
    await store.getState().update({ language: "en-US" });
    expect(mocks.setLanguage).toHaveBeenLastCalledWith("en-US");
  });

  it("keeps successfully loaded settings when app information fails", async () => {
    mocks.settings.mockResolvedValue({ ...DEFAULT_SETTINGS, monoFontSize: 19 });
    mocks.appInfo.mockRejectedValue(new Error("app info failed"));
    const store = await fresh();
    await store.getState().load();
    expect(store.getState().settings.monoFontSize).toBe(19);
    expect(store.getState().ready).toBe(true);
    expect(store.getState().error).toContain("app info failed");
    expect(document.documentElement.style.getPropertyValue("--td-mono-size")).toBe("19px");
  });

  it("still applies the native language when reading settings fails", async () => {
    mocks.settings.mockRejectedValue(new Error("settings failed"));
    const store = await fresh();
    await store.getState().load();
    expect(store.getState().ready).toBe(true);
    expect(mocks.setLanguage).toHaveBeenLastCalledWith("zh-CN");
  });

  it("serializes writes and keeps later optimistic changes after an earlier failure", async () => {
    const first = deferred<Settings>();
    mocks.updateSettings.mockReturnValueOnce(first.promise);
    const store = await fresh();
    const one = store.getState().update({ monoFontSize: 19 });
    const two = store.getState().update({ uiFontSize: 16 });
    await Promise.resolve();
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().settings).toMatchObject({ monoFontSize: 19, uiFontSize: 16 });
    first.reject(new Error("write failed"));
    expect(await one).toBe(false);
    expect(store.getState().settings).toMatchObject({
      monoFontSize: DEFAULT_SETTINGS.monoFontSize,
      uiFontSize: 16,
    });
    expect(await two).toBe(true);
    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
  });

  it("preserves optimistic changes while an older load completes", async () => {
    const read = deferred<Settings>();
    mocks.settings.mockReturnValueOnce(read.promise);
    const store = await fresh();
    const loading = store.getState().load();
    await Promise.resolve();
    const writing = store.getState().update({ monoFontSize: 20 });
    expect(store.getState().settings.monoFontSize).toBe(20);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    read.resolve({ ...DEFAULT_SETTINGS, monoFontSize: 11 });
    await loading;
    expect(store.getState().settings.monoFontSize).toBe(20);
    await writing;
    expect(store.getState().settings.monoFontSize).toBe(20);
  });

  it("does not replace a newer remote change with an old read", async () => {
    const read = deferred<Settings>();
    mocks.settings.mockReturnValueOnce(read.promise);
    const store = await fresh();
    const loading = store.getState().load();
    await Promise.resolve();
    store.getState().applyRemote({ ...DEFAULT_SETTINGS, monoFontSize: 21 });
    read.resolve(DEFAULT_SETTINGS);
    await loading;
    expect(store.getState().settings.monoFontSize).toBe(21);
  });

  it("orders reset between writes and rolls a failed reset back", async () => {
    const store = await fresh();
    await store.getState().update({ monoFontSize: 20 });
    const reset = deferred<Settings>();
    mocks.resetSettings.mockReturnValueOnce(reset.promise);
    const resetting = store.getState().reset();
    const writing = store.getState().update({ uiFontSize: 17 });
    expect(store.getState().settings).toMatchObject({
      monoFontSize: DEFAULT_SETTINGS.monoFontSize,
      uiFontSize: 17,
    });
    await Promise.resolve();
    reset.reject(new Error("reset failed"));
    await resetting;
    expect(store.getState().settings).toMatchObject({ monoFontSize: 20, uiFontSize: 17 });
    await writing;
  });

  it("serializes native locale changes and coalesces intermediate choices", async () => {
    const first = deferred<void>();
    mocks.setLocale.mockReturnValueOnce(first.promise);
    const { applySettings } = await import("@/store/settings");
    applySettings({ ...DEFAULT_SETTINGS, language: "en-US" });
    applySettings({ ...DEFAULT_SETTINGS, language: "zh-CN" });
    applySettings({ ...DEFAULT_SETTINGS, language: "en-US" });
    applySettings({ ...DEFAULT_SETTINGS, language: "zh-CN" });
    expect(mocks.setLocale).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(mocks.setLocale).toHaveBeenCalledTimes(2));
    expect(mocks.setLocale).toHaveBeenLastCalledWith("zh-CN");
  });

  it("retries a failed native locale update on a later application", async () => {
    mocks.setLocale.mockRejectedValueOnce(new Error("menu unavailable"));
    const { applySettings } = await import("@/store/settings");
    applySettings(DEFAULT_SETTINGS);
    await Promise.resolve();
    applySettings(DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(mocks.setLocale).toHaveBeenCalledTimes(2));
  });
});
