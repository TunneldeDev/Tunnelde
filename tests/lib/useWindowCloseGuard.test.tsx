// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, renderHook, waitFor } from "@testing-library/react";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "@/lib/api/ipc";

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  close: vi.fn(),
  onCloseRequested: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@/lib/api/ipc", async (original) => ({
  ...(await original<typeof IpcModule>()),
  isTauri: mocks.native,
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));

import "@/i18n/i18n";
import type { AppInfo } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useWindowCloseGuard } from "@/lib/session/useWindowCloseGuard";
import { useDialogs } from "@/store/dialogs";
import { useEditors, type EditorEntry } from "@/store/editors";
import { useSettings } from "@/store/settings";

function draft(tabId = "draft"): EditorEntry {
  return {
    tabId,
    sessionId: "session",
    path: `/etc/${tabId}.conf`,
    name: `${tabId}.conf`,
    content: "edited",
    baseline: "original",
    loading: false,
    saving: false,
    error: null,
  };
}

async function mount() {
  const rendered = renderHook(useWindowCloseGuard);
  await waitFor(() => expect(mocks.onCloseRequested).toHaveBeenCalledTimes(1));
  return rendered;
}

async function requestClose() {
  const event = { preventDefault: vi.fn() };
  await act(async () => {
    mocks.onCloseRequested.mock.calls.at(-1)![0](event as unknown as CloseRequestedEvent);
  });
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.native.mockReturnValue(true);
  mocks.close.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.onCloseRequested.mockResolvedValue(mocks.stop);
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, closeToTray: false },
    info: { os: "windows" } as AppInfo,
  });
  useEditors.setState({ entries: {} });
  useDialogs.getState().close();
});

describe("window close draft protection", () => {
  it("waits for native unsubscription before closing a clean window", async () => {
    let finish!: () => void;
    mocks.stop.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    await mount();
    await requestClose();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });

  it("keeps drafts on cancel and repeated close, then closes only on explicit discard", async () => {
    useEditors.setState({
      entries: { draft: draft(), second: { ...draft("second"), saving: true } },
    });
    await mount();
    await requestClose();
    const first = useDialogs.getState().dialog;
    expect(first.kind).toBe("confirm");
    if (first.kind !== "confirm") throw new Error("Missing discard confirmation");
    expect(first.body).toContain("draft.conf, second.conf");
    await requestClose();
    expect(useDialogs.getState().dialog).toBe(first);
    useDialogs.getState().close();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(useEditors.getState().entries.draft?.content).toBe("edited");
    await requestClose();
    const second = useDialogs.getState().dialog;
    if (second.kind !== "confirm") throw new Error("Missing second confirmation");
    await act(async () => second.onConfirm());
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("leaves macOS and tray closes to the existing native hide policy", async () => {
    useEditors.setState({ entries: { draft: draft() } });
    await mount();
    useSettings.setState({ info: { os: "macos" } as AppInfo });
    await requestClose();
    useSettings.setState({
      info: { os: "windows" } as AppInfo,
      settings: { ...DEFAULT_SETTINGS, closeToTray: true },
    });
    await requestClose();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(useDialogs.getState().dialog.kind).toBe("none");
    expect(useEditors.getState().entries.draft?.content).toBe("edited");
  });

  it("restores protection and retains drafts when the native close fails", async () => {
    mocks.close.mockRejectedValueOnce(new Error("Close failed"));
    useEditors.setState({ entries: { draft: draft() } });
    await mount();
    await requestClose();
    const dialog = useDialogs.getState().dialog;
    if (dialog.kind !== "confirm") throw new Error("Missing confirmation");
    await act(async () => dialog.onConfirm());
    expect(mocks.onCloseRequested).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalled();
    expect(useEditors.getState().entries.draft?.content).toBe("edited");
    useDialogs.getState().close();
    await requestClose();
    expect(useDialogs.getState().dialog.kind).toBe("confirm");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe in the browser and removes subscriptions resolving after unmount", async () => {
    mocks.native.mockReturnValue(false);
    const browser = renderHook(useWindowCloseGuard);
    expect(mocks.onCloseRequested).not.toHaveBeenCalled();
    browser.unmount();
    mocks.native.mockReturnValue(true);
    let finish!: (stop: () => void) => void;
    mocks.onCloseRequested.mockReturnValueOnce(
      new Promise<() => void>((resolve) => (finish = resolve)),
    );
    const native = renderHook(useWindowCloseGuard);
    native.unmount();
    await act(async () => finish(mocks.stop));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
