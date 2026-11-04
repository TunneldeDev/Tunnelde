import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { UpdateStatus } from "@/features/settings/UpdateSettings";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { UpdateState } from "@/lib/api/types";
import { useSettings } from "@/store/settings";
import { updateHistoryKey, useUpdates } from "@/store/updates";

vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
const load = vi.fn();
const update: UpdateState = {
  phase: "available",
  currentVersion: "0.27.1",
  version: "0.29.0",
  channel: "stable",
  source: "github",
  sourceUrl: "",
  notes: "## Target fixes",
  publishedAt: null,
  progress: null,
  contentLength: null,
  error: null,
  lastChecked: 123,
  available: true,
  autoInstall: true,
  unsupportedReason: null,
  downloadUrl: null,
  skipped: false,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useSettings.setState({ settings: createDefaultSettings(), saving: false });
  useUpdates.setState({ state: { ...update }, busy: false, history: null, loadHistory: load });
});

function toggle(details: HTMLDetailsElement, open: boolean) {
  details.open = open;
  fireEvent(details, new Event("toggle"));
}

it("loads history only on expansion and renders older Markdown only when expanded", () => {
  render(<UpdateStatus />);
  expect(load).not.toHaveBeenCalled();
  const outer = screen.getByText("Release notes · v0.27.1 → v0.29.0").closest("details")!;
  toggle(outer, true);
  expect(load).toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Target fixes" })).toBeTruthy();
  act(() =>
    useUpdates.setState({
      history: {
        key: updateHistoryKey(update),
        loading: false,
        error: null,
        data: {
          currentVersion: "0.27.1",
          version: "0.29.0",
          complete: true,
          reason: null,
          entries: [
            { version: "0.29.0", notes: "## Target fixes", publishedAt: null },
            { version: "0.28.0", notes: "## Previous fixes", publishedAt: 1793793600000 },
          ],
        },
      },
    }),
  );
  expect(screen.getByText(/All published notes.*2 releases/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Previous fixes" })).toBeNull();
  const older = screen.getByText("v0.28.0").closest("details")!;
  toggle(older, true);
  expect(screen.getByRole("heading", { name: "Previous fixes" })).toBeTruthy();
  toggle(older, false);
  expect(older.querySelector(".plugin-markdown")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Download and install" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("shows partial history with retry, without presenting it as an update failure", () => {
  useUpdates.setState({
    history: { key: updateHistoryKey(update), loading: false, data: null, error: "failed" },
  });
  render(<UpdateStatus />);
  toggle(screen.getByText("Release notes · v0.27.1 → v0.29.0").closest("details")!, true);
  expect(screen.getByText(/Release history could not be loaded completely/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Target fixes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(load).toHaveBeenCalledWith(true);
  expect(screen.getByText("Version 0.29.0 is available")).toBeTruthy();
});

it("explains custom-source coverage and still displays notes when the target has none", () => {
  useSettings.setState((store) => ({ settings: { ...store.settings, updateSource: "custom" } }));
  const custom = { ...update, source: "custom" as const, notes: null };
  useUpdates.setState({
    state: custom,
    history: {
      key: updateHistoryKey(custom),
      loading: false,
      error: null,
      data: {
        currentVersion: custom.currentVersion,
        version: custom.version!,
        complete: false,
        reason: "updates.historyCustom",
        entries: [{ version: custom.version!, notes: null, publishedAt: null }],
      },
    },
  });
  render(<UpdateStatus />);
  toggle(screen.getByText("Release notes · v0.27.1 → v0.29.0").closest("details")!, true);
  expect(screen.getByText(/This custom source provides notes/)).toBeTruthy();
  expect(screen.getByText("No release notes were published for this version.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("resets expansion and excludes cached content after target or check identity changes", () => {
  render(<UpdateStatus />);
  toggle(screen.getByText("Release notes · v0.27.1 → v0.29.0").closest("details")!, true);
  act(() =>
    useUpdates.getState().apply({ ...update, version: "0.30.0", notes: "## Different update" }),
  );
  const outer = screen.getByText("Release notes · v0.27.1 → v0.30.0").closest("details")!;
  expect(outer.open).toBe(false);
  expect(screen.queryByRole("heading", { name: "Target fixes" })).toBeNull();
});
