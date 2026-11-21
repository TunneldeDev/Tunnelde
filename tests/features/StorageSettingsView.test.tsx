import { useState } from "react";
import { create } from "zustand";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  StorageSettingsView,
  type StorageSettingsData,
  type StorageSettingsServices,
} from "@/features/settings/components/StorageSettingsView";
import { changeStorageDraft } from "@/features/settings/data/storageDraft";
import type { StorageChange } from "@/lib/api/storage";

vi.mock("@/store/storage", () => {
  throw new Error("Storage view imported main storage owner");
});
vi.mock("@/store/restartPrompt", () => {
  throw new Error("Storage view imported main restart owner");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Storage view imported direct IPC");
});

function fixture() {
  const state = create<StorageSettingsData>(() => ({
    status: {
      locations: [
        {
          category: "database",
          path: "/data/db",
          defaultPath: "/default/db",
          bytes: 512,
          files: 1,
          error: null,
          overridden: false,
        },
        {
          category: "pluginData",
          path: "/data/plugins",
          defaultPath: "/default/plugins",
          bytes: 1024,
          files: 2,
          error: null,
          overridden: false,
        },
      ],
      pending: null,
      previous: {},
      lastError: null,
    },
    loading: false,
    busy: false,
    error: null,
    draft: [],
    nativeAvailable: true,
  }));
  const captured = new Map<string, unknown>();
  const services: StorageSettingsServices = {
    useData: state,
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    load: vi.fn(async () => {}),
    changeDraft: vi.fn((change) =>
      state.setState(({ draft }) => ({ draft: changeStorageDraft(draft, change) })),
    ),
    schedule: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    pick: vi.fn(async () => "/chosen"),
    open: vi.fn(async () => {}),
    reviewRestart: vi.fn(),
    notify: vi.fn(),
  };
  const mount = () => render(<StorageSettingsView services={services} />);
  return { state, services, captured, mount };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("storage settings document-local boundary", () => {
  it("stages batch destinations without scheduling until review and only prompts restart after success", async () => {
    const owner = fixture();
    owner.mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Choose parent folder (2)" })),
    );
    expect(owner.state.getState().draft).toEqual([
      { category: "database", target: "/chosen/database", migrate: true },
      { category: "pluginData", target: "/chosen/plugin-data", migrate: true },
    ]);
    expect(owner.services.schedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review changes (2)" }));
    expect(within(screen.getByRole("dialog")).getByText("→ /chosen/plugin-data")).toBeTruthy();
    vi.mocked(owner.services.schedule).mockResolvedValueOnce(false);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Apply on next start" })),
    );
    expect(owner.services.reviewRestart).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(owner.state.getState().draft).toHaveLength(2);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Apply on next start" })),
    );
    expect(owner.services.schedule).toHaveBeenLastCalledWith([
      { category: "database", target: "/chosen/database", migrate: true },
      { category: "pluginData", target: "/chosen/plugin-data", migrate: true },
    ]);
    expect(owner.services.reviewRestart).toHaveBeenCalledOnce();
    expect(owner.state.getState().draft).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retains selection, review and empty-storage warnings across capture/remount", async () => {
    const owner = fixture();
    const view = owner.mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Settings & database" }));
    await act(async () =>
      fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]!),
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Migrate existing Settings & database data" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
    view.unmount();
    owner.mount();
    expect(
      (screen.getByRole("checkbox", { name: "Settings & database" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Existing data will NOT be copied. This category starts empty.",
      ),
    ).toBeTruthy();
    expect(owner.services.schedule).not.toHaveBeenCalled();
  });

  it("merges a picked category into the latest owner draft without overwriting another category", async () => {
    const owner = fixture();
    let resolve!: (value: string) => void;
    vi.mocked(owner.services.pick).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    owner.mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]!);
    expect(owner.services.useBusyGuard).toHaveBeenLastCalledWith(true);
    act(() =>
      owner.state.setState({
        draft: [{ category: "pluginData", target: "/newer/plugins", migrate: false }],
      }),
    );
    await act(async () => resolve("/selected/db"));
    expect(owner.state.getState().draft).toEqual([
      { category: "pluginData", target: "/newer/plugins", migrate: false },
      { category: "database", target: "/selected/db", migrate: true },
    ]);
    expect(owner.services.useBusyGuard).toHaveBeenLastCalledWith(false);
  });

  it("locks pending plans and delegates cancellation and restart recovery", async () => {
    const owner = fixture();
    const status = owner.state.getState().status!;
    owner.state.setState({
      status: { ...status, pending: { id: "pending", changes: [], restartRequested: true } },
    });
    owner.mount();
    expect(
      screen
        .getAllByRole("button", { name: "Choose folder" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("storage.recovery.reviewRestart") }));
    expect(owner.services.reviewRestart).toHaveBeenCalledOnce();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled changes" })),
    );
    expect(owner.services.cancel).toHaveBeenCalledOnce();
    expect(owner.services.pick).not.toHaveBeenCalled();
  });

  it("keeps chooser cancellation silent and reports folder-opening errors through its owner", async () => {
    const owner = fixture();
    vi.mocked(owner.services.pick).mockResolvedValueOnce(null);
    vi.mocked(owner.services.open).mockRejectedValueOnce(new Error("Fixture open failed"));
    owner.mount();
    await act(async () =>
      fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]!),
    );
    expect(owner.services.changeDraft).not.toHaveBeenCalled();
    expect(owner.services.notify).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t("storage.openCategory", { category: i18n.t("storage.categories.database") }),
        }),
      ),
    );
    expect(owner.services.open).toHaveBeenCalledWith("database");
    expect(owner.services.notify).toHaveBeenCalledWith("Fixture open failed", "error");
  });

  it("applies only the requested category mutation without modifying the original draft", () => {
    const draft: StorageChange[] = [
      { category: "database", target: "/db", migrate: true },
      { category: "keys", target: "/keys", migrate: false },
    ];
    expect(
      changeStorageDraft(draft, { kind: "migrate", category: "database", migrate: false }),
    ).toEqual([{ ...draft[0], migrate: false }, draft[1]]);
    expect(changeStorageDraft(draft, { kind: "remove", categories: ["database"] })).toEqual([
      draft[1],
    ]);
    expect(changeStorageDraft(draft, { kind: "clear" })).toEqual([]);
    expect(draft).toHaveLength(2);
    expect(draft[0]?.migrate).toBe(true);
  });
});
