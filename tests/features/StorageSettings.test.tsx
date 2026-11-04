import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { StorageSettings } from "@/features/settings/StorageSettings";
import { useStorage } from "@/store/storage";
import type { StorageStatus } from "@/lib/api/storage";

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
