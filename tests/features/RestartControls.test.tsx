import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { RestartPrompt } from "@/components/layout/RestartPrompt";
import { StorageSettings } from "@/features/settings/StorageSettings";
import { useStorage } from "@/store/storage";
import { useRestartPrompt } from "@/store/restartPrompt";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { requestApplicationAction } from "@/lib/session/restart";
import type { StorageStatus } from "@/lib/api/storage";

const api = vi.hoisted(() => ({
  storageStatus: vi.fn(),
  storageRestartPending: vi.fn(),
  storageSchedule: vi.fn(),
  storageCancel: vi.fn(),
  storagePick: vi.fn(),
  storageOpen: vi.fn(),
  appRestart: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
const empty: StorageStatus = {
  locations: [
    {
      category: "database",
      path: "C:\\Data",
      defaultPath: "C:\\Data",
      bytes: 0,
      files: 0,
      error: null,
      overridden: false,
    },
  ],
  pending: null,
  previous: {},
  lastError: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useStorage.setState({
    status: null,
    restartPending: false,
    loading: false,
    busy: false,
    error: null,
    draft: [],
  });
  useRestartPrompt.setState({ open: false });
  useDialogs.getState().close();
  useEditors.setState({ entries: {} });
  useSettings.setState((state) => ({ settings: { ...state.settings, showStatusBar: false } }));
  api.storageStatus.mockResolvedValue(empty);
  api.storageRestartPending.mockResolvedValue(false);
  api.storagePick.mockResolvedValue("D:\\Data");
  api.storageSchedule.mockImplementation(async (changes) => ({
    ...empty,
    pending: { id: "one", changes },
  }));
  api.storageCancel.mockResolvedValue(empty);
});

it("prompts after scheduling, keeps a restart entry after deferring, and removes it after cancellation", async () => {
  render(
    <>
      <StorageSettings />
      <RestartPrompt />
    </>,
  );
  await screen.findByText("Settings & database");
  fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
  await screen.findByRole("switch");
  fireEvent.click(screen.getByRole("button", { name: "Review changes (1)" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Apply on next start" }),
  );
  await screen.findByRole("dialog", { name: "Restart required" });
  fireEvent.click(screen.getByRole("button", { name: "Restart later" }));
  expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
  expect(useDialogs.getState().dialog.kind).toBe("confirm");
  fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled changes" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull());
});

it("warns about dirty files before calling native restart", async () => {
  useEditors.setState({
    entries: {
      a: {
        tabId: "a",
        sessionId: "",
        path: "/a",
        name: "a.json",
        content: "new",
        baseline: "old",
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  requestApplicationAction("restart");
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind !== "confirm") return;
  expect(dialog.body).toContain("a.json");
  expect(api.appRestart).not.toHaveBeenCalled();
  await dialog.onConfirm();
  expect(api.appRestart).toHaveBeenCalledOnce();
});

it("ignores an older pending-status response after a plan is cancelled", async () => {
  let resolve!: (pending: boolean) => void;
  api.storageRestartPending.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const loading = useStorage.getState().loadRestartPending();
  await useStorage.getState().cancel();
  resolve(true);
  await loading;
  expect(useStorage.getState().restartPending).toBe(false);
});

it("ignores a pending-status response started during cancellation", async () => {
  let finishCancel!: (status: StorageStatus) => void;
  let finishCheck!: (pending: boolean) => void;
  api.storageCancel.mockReturnValue(
    new Promise<StorageStatus>((done) => {
      finishCancel = done;
    }),
  );
  api.storageRestartPending.mockReturnValue(
    new Promise<boolean>((done) => {
      finishCheck = done;
    }),
  );
  const cancel = useStorage.getState().cancel();
  const check = useStorage.getState().loadRestartPending();
  finishCancel(empty);
  await cancel;
  finishCheck(true);
  await check;
  expect(useStorage.getState().restartPending).toBe(false);
});
