import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { OutputPanel } from "@/features/output/OutputPanel";
import { useNavigation } from "@/store/navigation";
import {
  boundOutput,
  matchesOutput,
  parseDiagnostic,
  snapshotEntries,
} from "@/features/output/model";

const api = vi.hoisted(() => ({
  logsOutputRead: vi.fn(),
  openLatestLog: vi.fn(),
  openLogDir: vi.fn(),
  clipboardWriteText: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({ api, isTauri: () => true }));
vi.mock("@/store/plugins", () => ({
  usePlugins: (select: (state: unknown) => unknown) => select({ items: [] }),
}));
vi.mock("@/store/settings", () => ({
  useSettings: (select: (state: unknown) => unknown) =>
    select({
      info: {
        name: "Tunnelde",
        version: "1.2.3",
        os: "windows",
        arch: "x86_64",
        tauriVersion: "2",
        debug: false,
      },
    }),
}));
vi.mock("@/store/ssh", () => ({
  useSsh: (select: (state: unknown) => unknown) => select({ sessions: [] }),
}));
const cursor = { filename: "2026-11-08.tunnelde.jsonl.log", offset: 100, operationId: 0 };
const diagnostic = JSON.stringify({
  timestamp: "2026-11-08T02:44:42Z",
  level: "WARN",
  target: "tunnelde_lib::commands",
  fields: {
    message: "plugin start failed",
    plugin_id: "formatter",
    reason: "plugin.engine.unsupported",
  },
});
const snapshot = { diagnostic: diagnostic + "\n", operations: [], cursor, truncated: false };

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  api.logsOutputRead.mockResolvedValue(snapshot);
  api.openLatestLog.mockResolvedValue(undefined);
  api.openLogDir.mockResolvedValue(undefined);
  api.clipboardWriteText.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it("parses plugin fields, module and severity without losing the failure reason", () => {
  const entry = { ...parseDiagnostic(diagnostic), id: 1 };
  expect(entry).toMatchObject({
    plugin: "formatter",
    domain: "commands",
    level: "WARN",
    message: "plugin start failed · reason=plugin.engine.unsupported",
  });
  expect(matchesOutput(entry, "plugin:formatter", "unsupported", "WARN")).toBe(true);
  expect(matchesOutput(entry, "plugin:other", "", "TRACE")).toBe(false);
  expect(matchesOutput(entry, "domain:commands", "", "ERROR")).toBe(false);
  expect(parseDiagnostic("plain text\u001b[31m").message).toBe("plain text");
  expect(
    parseDiagnostic(
      JSON.stringify({ fields: { message: "fine", level: "debug", plugin: "other" } }),
    ),
  ).toMatchObject({ level: "DEBUG", plugin: "other" });
});

it("bounds retained content and merges operation records in timestamp order", () => {
  let id = 0;
  const entries = snapshotEntries(
    { ...snapshot, operations: [{ id: 1, timestamp: 1, action: "host.create", target: "opaque" }] },
    () => ++id,
  );
  expect(entries[0]?.kind).toBe("operations");
  const huge = boundOutput(
    Array.from({ length: 3000 }, (_, i) => ({ ...entries[1]!, id: i, message: "x".repeat(30000) })),
  );
  expect(huge.omitted).toBe(true);
  expect(huge.entries.at(-1)?.id).toBe(2999);
  expect(huge.entries.reduce((sum, item) => sum + item.message.length, 0)).toBeLessThan(
    1024 * 1024,
  );
});

it("renders readable output, filters plugin channels, copies and clears without deleting logs", async () => {
  render(<OutputPanel active />);
  expect(await screen.findByText(/plugin start failed · reason=/)).toBeTruthy();
  expect(screen.queryByText(/"timestamp":/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Output channel" }));
  fireEvent.click(screen.getByRole("option", { name: "Plugin: formatter" }));
  fireEvent.click(screen.getByRole("button", { name: "Output actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy displayed output" }));
  expect(api.clipboardWriteText).toHaveBeenCalledWith(
    expect.stringContaining("[WARN] [formatter]"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Filter output…" }), {
    target: { value: "missing" },
  });
  expect(screen.getByText("No entries match these filters.")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter output…" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear displayed output" }));
  expect(screen.queryByText(/plugin start failed · reason=/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Output actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open original log" }));
  expect(api.openLatestLog).toHaveBeenCalledOnce();
});

it("stops polling when hidden and resumes from the last cursor without reloading old output", async () => {
  const view = render(<OutputPanel active />);
  await screen.findByText(/plugin start failed · reason=/);
  vi.useFakeTimers();
  view.rerender(<OutputPanel active={false} />);
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(api.logsOutputRead).toHaveBeenCalledTimes(1);
  api.logsOutputRead.mockResolvedValue({ ...snapshot, diagnostic: "" });
  view.rerender(<OutputPanel active />);
  await act(() => Promise.resolve());
  expect(api.logsOutputRead).toHaveBeenLastCalledWith(cursor);
  expect(screen.getAllByText(/plugin start failed · reason=/)).toHaveLength(1);
});

it("surfaces read failures and permits retry; runtime information does not depend on log success", async () => {
  api.logsOutputRead.mockRejectedValueOnce(new Error("Read failed"));
  render(<OutputPanel active />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Output actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Output channel" }));
  fireEvent.click(screen.getByRole("option", { name: "Runtime information" }));
  expect(screen.getByText(/Tunnelde 1.2.3/)).toBeTruthy();
});

it("does not read logs while the panel is inactive", () => {
  useNavigation.setState({ activeSidebar: "hosts" });
  render(<OutputPanel active={false} />);
  expect(api.logsOutputRead).not.toHaveBeenCalled();
});
