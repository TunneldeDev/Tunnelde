import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import "@/i18n/i18n";
import { AboutPage } from "@/features/about/AboutPage";

it("includes the full local font copyright and license in About", () => {
  render(<AboutPage />);
  fireEvent.click(screen.getByRole("button", { name: "Third-party notices" }));
  const dialog = screen.getByRole("dialog", { name: "Third-party notices" });
  expect(within(dialog).getByText(/SIL OPEN FONT LICENSE Version 1.1/).textContent).toContain(
    "Copyright",
  );
  expect(dialog.textContent).toContain("PERMISSION & CONDITIONS");
});
