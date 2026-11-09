import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { OutputPanel } from "@/features/output/OutputPanel";
import { useNavigation } from "@/store/navigation";
import {
  boundOutput,
  formatOutput,
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

it("uses explicit shared-log domains for source and plugin filtering", () => {
  const entry = {
    ...parseDiagnostic(
      JSON.stringify({
        level: "ERROR",
        target: "tunnelde_lib::diagnostics",
        fields: {
          message: "Connection failed",
          domain: "plugins.example.connection",
          plugin_id: "example",
          operation: "connect",
          request_id: "req-1",
          context: '{"status":403}',
        },
      }),
    ),
    id: 1,
  };
  expect(entry).toMatchObject({
    level: "ERROR",
    domain: "plugins.example.connection",
    plugin: "example",
  });
  expect(
    matchesOutput(entry, "domain:plugins.example.connection", "plugin:example level:ERROR", "WARN"),
  ).toBe(true);
  expect(entry.message).toContain("request_id=req-1");
  expect(entry.message).not.toContain("domain=");
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

it("keeps severity, source, time and message separately styled while copying the same plain text", async () => {
  const levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
  api.logsOutputRead.mockResolvedValue({
    ...snapshot,
    diagnostic: levels
      .map((level) => JSON.stringify({ ...JSON.parse(diagnostic), level }))
      .join("\n"),
  });
  const { container } = render(<OutputPanel active />);
  await waitFor(() => expect(container.querySelectorAll(".output-panel__line")).toHaveLength(5));
  for (const level of levels) {
    const line = container.querySelector(`.output-panel__line.is-${level.toLowerCase()}`)!;
    expect(line.querySelector(".output-panel__level")?.textContent).toBe(`[${level}]`);
    expect(line.querySelector(".output-panel__source")?.textContent).toBe("[formatter]");
    expect(line.querySelector(".output-panel__time")?.textContent?.trim()).toBeTruthy();
    expect(line.textContent).toBe(
      formatOutput({ ...parseDiagnostic(diagnostic), id: 1, level }) + "\n",
    );
  }
  fireEvent.click(screen.getByRole("button", { name: "Output actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy displayed output" }));
  expect(api.clipboardWriteText).toHaveBeenCalledWith(
    container.querySelector(".output-panel__lines")!.textContent!.trimEnd(),
  );
});

it("preserves plain-text formatting for untimestamped and empty messages", async () => {
  api.logsOutputRead.mockResolvedValue({
    ...snapshot,
    diagnostic: ["  indented output  ", JSON.stringify({ fields: { message: "   " } })].join("\n"),
  });
  const { container } = render(<OutputPanel active />);
  await waitFor(() => expect(container.querySelectorAll(".output-panel__line")).toHaveLength(2));
  const lines = container.querySelectorAll(".output-panel__line");
  expect(lines[0]!.textContent).toBe("[INFO] [application]   indented output\n");
  expect(lines[1]!.textContent).toBe("[INFO] [application]\n");
  fireEvent.click(screen.getByRole("button", { name: "Output actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy displayed output" }));
  expect(api.clipboardWriteText).toHaveBeenCalledWith(
    container.querySelector(".output-panel__lines")!.textContent!.trimEnd(),
  );
});
