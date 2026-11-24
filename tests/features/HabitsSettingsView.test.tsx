import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HabitsSettingsView } from "@/features/settings/components/HabitsSettingsView";
import i18n from "@/i18n/i18n";
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
it("reviews explicit categories before resetting and keeps a failed review visible", async () => {
  const reset = vi.fn().mockRejectedValue(new Error("save failed"));
  render(
    <HabitsSettingsView
      data={{ ready: true, saving: false, error: null, entries: 2, workspaceCleared: false }}
      loadDetails={vi.fn().mockResolvedValue([])}
      reset={reset}
      selectSection={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /Fonts and font sizes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Reset selected habits" }));
  expect(reset).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Fonts and font sizes")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset selected habits" }));
  await waitFor(() => expect(reset).toHaveBeenCalledWith(["typography"]));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("save failed"));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("loads concrete saved data only on expansion and keeps expansion separate from reset selection", async () => {
  const loadDetails = vi
    .fn()
    .mockResolvedValue([
      {
        label: "tasks · Position and size",
        value: '{"x":638,"y":128,"width":540,"height":560}',
        origin: "saved",
      },
    ]);
  render(
    <HabitsSettingsView
      data={{ ready: true, saving: false, error: null, entries: 1, workspaceCleared: false }}
      reset={vi.fn()}
      loadDetails={loadDetails}
      selectSection={vi.fn()}
    />,
  );
  expect(loadDetails).not.toHaveBeenCalled();
  const summary = screen.getByText("Show specific data · Panel position and state");
  fireEvent.click(summary);
  await waitFor(() => expect(loadDetails).toHaveBeenCalledWith("panels"));
  expect(await screen.findByText(/"x":638/)).toBeTruthy();
  expect(screen.getByText("Saved")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset selected habits" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
