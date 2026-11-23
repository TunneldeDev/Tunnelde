import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  FontSettingsView,
  type FontSettingsServices,
} from "@/features/settings/components/FontSettingsView";
import { useLocalControlState } from "@/features/settings/components/controlState";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { FontInfo } from "@/lib/fonts/types";
import { FONT_READY_EVENT, previewFont } from "@/lib/fonts/runtime";
import type * as FontsRuntime from "@/lib/fonts/runtime";

vi.mock("@/lib/fonts/runtime", async (original) => ({
  ...(await original<typeof FontsRuntime>()),
  previewFont: vi.fn(async () => ({ family: "Preview", monospaced: true, dispose: vi.fn() })),
}));
const local: FontInfo = {
  reference: { source: "system", family: "Local Mono" },
  name: "Local Mono",
  monospaced: true,
};
const imported: FontInfo = {
  reference: { source: "imported", id: "a".repeat(64) },
  name: "User Font",
  monospaced: false,
  format: "woff2",
  bytes: 1000,
};
const defaults = createDefaultSettings();
const makeServices = (): FontSettingsServices => ({
  catalogue: vi.fn(async () => ({ version: 1 as const, items: [local, imported] })),
  importFile: vi.fn(async () => imported),
  remove: vi.fn(async () => undefined),
  select: vi.fn(async () => undefined),
  confirm: vi.fn(),
  useViewState: useLocalControlState,
});
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
});

it("selects a system font for one target and preserves the other selections", async () => {
  const services = makeServices();
  render(
    <FontSettingsView
      settings={{
        ...defaults,
        fontSelections: { ui: null, mono: imported.reference, editorCjk: null },
      }}
      services={services}
    />,
  );
  await waitFor(() => expect(services.catalogue).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Interface font" }));
  fireEvent.click(await screen.findByRole("option", { name: "System · Local Mono" }));
  await waitFor(() => expect(services.select).toHaveBeenCalledWith("ui", local.reference));
});

it("searches the catalogue, previews an imported font and applies it without importing again", async () => {
  const services = makeServices();
  render(<FontSettingsView settings={defaults} services={services} />);
  await screen.findByText(/User Font · WOFF2/);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "User" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview font" }));
  expect(screen.queryByRole("option", { name: "System · Local Mono" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "Imported · User Font" }));
  await waitFor(() => expect(vi.mocked(previewFont)).toHaveBeenCalledWith(imported.reference));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Use for editor CJK" })),
  );
  expect(services.select).toHaveBeenCalledWith("editorCjk", imported.reference);
  expect(services.importFile).not.toHaveBeenCalled();
});

it("requires confirmation before deleting an active font and handles cancelled import", async () => {
  const services = makeServices();
  vi.mocked(services.importFile).mockResolvedValue(null);
  render(
    <FontSettingsView
      settings={{
        ...defaults,
        fontSelections: { ...defaults.fontSelections, ui: imported.reference },
      }}
      services={services}
    />,
  );
  await screen.findByText(/User Font · WOFF2/);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(services.remove).not.toHaveBeenCalled();
  const confirmation = vi.mocked(services.confirm).mock.calls[0]![0];
  expect(confirmation.body).toContain("restore");
  await act(async () => confirmation.onConfirm());
  expect(services.remove).toHaveBeenCalledWith("a".repeat(64));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Import font…" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Import font…" })));
  expect(services.select).not.toHaveBeenCalled();
});

it("retains unavailable references with a fallback disclosure", async () => {
  const services = makeServices();
  vi.mocked(services.catalogue).mockResolvedValue({ version: 1, items: [] });
  render(
    <FontSettingsView
      settings={{
        ...defaults,
        fontSelections: { ...defaults.fontSelections, ui: imported.reference },
      }}
      services={services}
    />,
  );
  expect(await screen.findByText(/This font is unavailable/)).toBeTruthy();
  expect(services.select).not.toHaveBeenCalled();
});

it("loads the catalogue only after the Settings window owns a live lease", async () => {
  const services = makeServices();
  const { rerender } = render(
    <FontSettingsView settings={defaults} services={services} live={false} />,
  );
  fireEvent(window, new Event(FONT_READY_EVENT));
  expect(services.catalogue).not.toHaveBeenCalled();
  rerender(<FontSettingsView settings={defaults} services={services} live />);
  await screen.findByText(/User Font · WOFF2/);
  expect(services.catalogue).toHaveBeenCalledOnce();
});

it("clears a catalogue error on recovery", async () => {
  const services = makeServices();
  vi.mocked(services.catalogue).mockRejectedValueOnce(new Error("initial failure"));
  render(<FontSettingsView settings={defaults} services={services} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh system fonts" }));
  await screen.findByText(/User Font · WOFF2/);
  expect(screen.queryByRole("alert")).toBeNull();
});
