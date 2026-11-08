import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { LogViewer } from "@/features/settings/LogViewer";
import { useNavigation } from "@/store/navigation";

it("opens the shared dockable output panel from settings", async () => {
  await i18n.changeLanguage("en-US");
  const open = vi.spyOn(useNavigation.getState(), "showOutput");
  render(<LogViewer />);
  fireEvent.click(screen.getByRole("button", { name: "Show output" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});
