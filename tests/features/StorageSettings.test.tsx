import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { StorageSettings } from "@/features/settings/StorageSettings";
import { useStorage } from "@/store/storage";
import { sameStoragePath, type StorageStatus } from "@/lib/api/storage";
import { useRestartPrompt } from "@/store/restartPrompt";

const api = vi.hoisted(() => ({
  storageStatus: vi.fn(),
  storageSchedule: vi.fn(),
  storageCancel: vi.fn(),
  storagePick: vi.fn(),
  storageOpen: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
const status = (): StorageStatus => ({
  locations: [
    {
      category: "database",
      path: "C:\\Data",
      defaultPath: "C:\\Data",
      bytes: 500,
      files: 1,
      error: null,
      overridden: false,
    },
    {
      category: "pluginData",
      path: "C:\\Data\\plugin-data",
      defaultPath: "C:\\Data\\plugin-data",
      bytes: 1000,
      files: 2,
      error: null,
      overridden: false,
    },
  ],
  pending: null,
  previous: {},
  lastError: null,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useStorage.setState({ status: null, loading: false, busy: false, error: null, draft: [] });
  api.storageStatus.mockResolvedValue(status());
  api.storagePick.mockResolvedValue("D:\\Tunnelde");
  api.storageSchedule.mockImplementation(async (changes) => ({
    ...status(),
    pending: { id: "plan", changes },
  }));
  api.storageCancel.mockResolvedValue(status());
});

it("batches separate category folders and schedules only after reviewing destinations", async () => {
  render(<StorageSettings />);
  await screen.findByText("Settings & database");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose parent folder (2)" }));
  await screen.findByText("D:\\Tunnelde\\database");
  expect(api.storageSchedule).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review changes (2)" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("→ D:\\Tunnelde\\plugin-data")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply on next start" }));
  await waitFor(() =>
    expect(api.storageSchedule).toHaveBeenCalledWith([
      { category: "database", target: "D:\\Tunnelde\\database", migrate: true },
      { category: "pluginData", target: "D:\\Tunnelde\\plugin-data", migrate: true },
    ]),
  );
  await screen.findByText("Location changes are scheduled");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen
      .getAllByRole("button", { name: "Choose folder" })
      .every((button) => button.hasAttribute("disabled")),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled changes" }));
  await waitFor(() => expect(api.storageCancel).toHaveBeenCalledOnce());
});

it("preserves drafts across remount and warns explicitly when starting empty", async () => {
  const view = render(<StorageSettings />);
  await screen.findByText("Settings & database");
  fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]!);
  await screen.findByRole("switch", { name: "Migrate existing Settings & database data" });
  fireEvent.click(screen.getByRole("switch"));
  view.unmount();
  render(<StorageSettings />);
  await screen.findByText("Start with empty storage; keep the original data");
  await waitFor(() => expect(useStorage.getState().loading).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
  expect(
    within(screen.getByRole("dialog")).getByText(
      "Existing data will NOT be copied. This category starts empty.",
    ),
  ).toBeTruthy();
});

it("keeps the review open and draft intact on native validation failure", async () => {
  api.storageSchedule.mockRejectedValue({ code: "validation", message: "storage.targetNotEmpty" });
  render(<StorageSettings />);
  await screen.findByText("Settings & database");
  fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]!);
  await screen.findByRole("switch");
  fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Apply on next start" }),
  );
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain(
      "empty or new folder",
    ),
  );
  expect(useStorage.getState().draft).toHaveLength(1);
  expect(useStorage.getState().status?.pending).toBeNull();
});

it("ignores a stale inventory response arriving after scheduling a plan", async () => {
  let resolve!: (status: StorageStatus) => void;
  api.storageStatus.mockImplementationOnce(
    () =>
      new Promise<StorageStatus>((done) => {
        resolve = done;
      }),
  );
  const loading = useStorage.getState().load();
  const changes = [{ category: "database" as const, target: "D:\\New", migrate: true }];
  await useStorage.getState().schedule(changes);
  resolve(status());
  await loading;
  expect(useStorage.getState().status?.pending?.changes).toEqual(changes);
});

it("resets a moved category through the existing review and migration flow", async () => {
  const moved = status();
  moved.locations[0]!.path = "D:\\Tunnelde\\database";
  api.storageStatus.mockResolvedValue(moved);
  render(<StorageSettings />);
  const reset = await screen.findByRole("button", {
    name: "Reset Settings & database to its default location",
  });
  await waitFor(() => expect(reset.hasAttribute("disabled")).toBe(false));
  fireEvent.click(reset);
  expect(api.storagePick).not.toHaveBeenCalled();
  expect(api.storageSchedule).not.toHaveBeenCalled();
  expect(useStorage.getState().draft).toEqual([
    { category: "database", target: "C:\\Data", migrate: true },
  ]);
  expect(reset.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("→ C:\\Data")).toBeTruthy();
  expect(
    within(dialog).getByText(/Existing data at the default location will be archived/),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply on next start" }));
  await waitFor(() =>
    expect(api.storageSchedule).toHaveBeenCalledWith([
      { category: "database", target: "C:\\Data", migrate: true },
    ]),
  );
});

it("batch reset removes redundant drafts, preserves unselected changes and skips environment overrides", async () => {
  const moved = status();
  moved.locations[1]!.path = "D:\\Chats";
  moved.locations.push({ ...moved.locations[1]!, category: "plugins", overridden: true });
  api.storageStatus.mockResolvedValue(moved);
  useStorage.setState({
    draft: [
      { category: "database", target: "D:\\Database", migrate: false },
      { category: "logs", target: "D:\\Logs", migrate: false },
    ],
  });
  render(<StorageSettings />);
  await screen.findByText("Installed plugins");
  await waitFor(() => expect(useStorage.getState().loading).toBe(false));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(screen.getByRole("checkbox", { name: "Installed plugins" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset selected locations (2)" }));
  expect(useStorage.getState().draft).toEqual([
    { category: "logs", target: "D:\\Logs", migrate: false },
    { category: "pluginData", target: "C:\\Data\\plugin-data", migrate: true },
  ]);
  expect(
    screen.getByRole("button", { name: "Reset selected locations (2)" }).hasAttribute("disabled"),
  ).toBe(true);
});

it("locks reset actions while a migration is pending and recognizes default Windows path spellings", async () => {
  const pending = status();
  pending.locations[0]!.path = "D:\\Database";
  pending.pending = {
    id: "plan",
    changes: [{ category: "database", target: "E:\\Database", migrate: true }],
  };
  api.storageStatus.mockResolvedValue(pending);
  render(<StorageSettings />);
  const reset = await screen.findByRole("button", {
    name: "Reset Settings & database to its default location",
  });
  expect(reset.hasAttribute("disabled")).toBe(true);
  expect(sameStoragePath("\\\\?\\C:\\Data\\", "c:/data")).toBe(true);
  expect(sameStoragePath("\\\\?\\UNC\\server\\Share\\", "\\\\SERVER\\share")).toBe(true);
  expect(sameStoragePath("/home/Data", "/home/data")).toBe(false);
  expect(sameStoragePath("/", "")).toBe(false);
});

it("shows archived default data alongside the retained migration source", async () => {
  const restored = status();
  restored.previous = { database: "D:\\CurrentDatabase" };
  restored.archives = { database: "C:\\Data\\storage-recovery\\database\\id\\original" };
  api.storageStatus.mockResolvedValue(restored);
  render(<StorageSettings />);
  await screen.findByText("Recovery copy — Settings & database");
  expect(screen.getByText("D:\\CurrentDatabase")).toBeTruthy();
  expect(screen.getByText(restored.archives.database!)).toBeTruthy();
});

it("shows persisted cancellation after failure and allows retry without advertising new paths", async () => {
  const planned = status();
  planned.pending = {
    id: "plan",
    changes: [{ category: "database", target: "E:\\Database", migrate: true }],
  };
  api.storageStatus.mockResolvedValueOnce(planned).mockResolvedValue({
    ...planned,
    pending: { ...planned.pending, action: "cancel" },
    lastError: "storage.verificationFailed",
  });
  api.storageCancel.mockRejectedValueOnce(new Error("storage.verificationFailed"));
  render(<StorageSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel scheduled changes" }));
  await screen.findByText("Storage cancellation needs recovery");
  expect(
    screen.getByText(/Cancellation is incomplete\. Current storage locations remain active\./),
  ).toBeTruthy();
  expect(screen.queryByText(/Migration did not complete/)).toBeNull();
  expect(screen.queryByText("Location changes are scheduled")).toBeNull();
  expect(screen.queryByText("E:\\Database")).toBeNull();
  expect(screen.queryByRole("button", { name: /Review changes/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry cancellation" }));
  await waitFor(() => expect(api.storageCancel).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(useStorage.getState().status?.pending).toBeNull());
});

it("shows a cancelled staging recovery copy even before any migration has succeeded", async () => {
  const cancelled = status();
  cancelled.archives = { pluginData: "D:\\Recovery\\cancelled" };
  api.storageStatus.mockResolvedValue(cancelled);
  render(<StorageSettings />);
  await screen.findByText("Recovery copy — Plugin data & chats");
  expect(screen.getByText("D:\\Recovery\\cancelled")).toBeTruthy();
});

it.each(["apply", "cancel"] as const)(
  "distinguishes deferred %s from a failed recovery and offers restart timing",
  async (action) => {
    const deferred = status();
    deferred.pending = {
      id: "plan",
      action,
      restartRequested: true,
      changes: [{ category: "database", target: "E:\\Database", migrate: true }],
    };
    deferred.lastError = "storage.verificationFailed";
    api.storageStatus.mockResolvedValue(deferred);
    useRestartPrompt.getState().close();
    render(<StorageSettings />);
    await screen.findByText("Storage recovery scheduled");
    expect(
      screen.getByText(/Previous recovery error \(new request has not run yet\):/),
    ).toBeTruthy();
    expect(screen.queryByText("Storage cancellation needs recovery")).toBeNull();
    expect(
      screen.getByText(
        action === "cancel"
          ? "The next startup will continue cancelling this plan. Current storage locations remain active and recovery copies are retained."
          : "The next startup will retry this migration. Current storage locations remain active.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose when to restart" }));
    expect(useRestartPrompt.getState().open).toBe(true);
    expect(api.storageCancel).not.toHaveBeenCalled();
    useRestartPrompt.getState().close();
  },
);
