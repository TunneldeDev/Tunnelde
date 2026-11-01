import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryPage } from "@/features/history/HistoryPage";
import { useSsh } from "@/store/ssh";
import type { HistoryEntry, SshSession } from "@/lib/api/types";

const mocks = vi.hoisted(() => ({ historyList: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: mocks }));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/i18n/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "en-US" } }),
}));
const entry = (id: number, command: string): HistoryEntry => ({
  id,
  hostId: "one",
  command,
  executedAt: Date.now(),
});
const session = (hostId: string): SshSession => ({
  id: "session",
  hostId,
  title: "SSH",
  address: "host",
  cols: 80,
  rows: 24,
  connectedAt: 0,
});
beforeEach(() => {
  mocks.historyList.mockReset().mockResolvedValue([entry(1, "first command")]);
  mocks.toast.mockReset();
  useSsh.setState({ sessions: [session("one")] });
});

describe("history changes from other views and plugins", () => {
  it("refreshes on domain changes and removes its listener on unmount", async () => {
    const view = render(<HistoryPage sessionId="session" />);
    await screen.findByText("first command");
    mocks.historyList.mockResolvedValue([entry(2, "new command")]);
    act(() => window.dispatchEvent(new Event("tunnelde:history-changed")));
    await screen.findByText("new command");
    expect(screen.queryByText("first command")).toBeNull();
    view.unmount();
    window.dispatchEvent(new Event("tunnelde:history-changed"));
    expect(mocks.historyList).toHaveBeenCalledTimes(2);
  });

  it("ignores an older request that resolves after a newer refresh", async () => {
    let resolveOld!: (entries: HistoryEntry[]) => void;
    mocks.historyList.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    render(<HistoryPage sessionId="session" />);
    mocks.historyList.mockResolvedValue([entry(2, "latest command")]);
    act(() => window.dispatchEvent(new Event("tunnelde:history-changed")));
    await screen.findByText("latest command");
    await act(async () => resolveOld([entry(1, "outdated command")]));
    expect(screen.queryByText("outdated command")).toBeNull();
    expect(screen.getByText("latest command")).toBeTruthy();
  });

  it("clears the previous host list while the next host is loading", async () => {
    render(<HistoryPage sessionId="session" />);
    await screen.findByText("first command");
    mocks.historyList.mockReturnValue(new Promise(() => {}));
    act(() => useSsh.setState({ sessions: [session("two")] }));
    await waitFor(() => expect(screen.queryByText("first command")).toBeNull());
    expect(mocks.historyList).toHaveBeenLastCalledWith("two");
  });
});
