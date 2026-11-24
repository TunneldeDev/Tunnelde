import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import "@/i18n/i18n";
import { AboutPage } from "@/features/about/AboutPage";

it("shows local notices for current dependencies and bundled fonts", () => {
  render(<AboutPage />);
  fireEvent.click(screen.getByRole("button", { name: "Third-party notices" }));
  const dialog = screen.getByRole("dialog", { name: "Third-party notices" });
  expect(within(dialog).getByText(/SIL Open Font License/).textContent).toContain("Fira Code");
  expect(dialog.textContent).toContain("fontdb");
  expect(dialog.textContent).not.toContain("Noto Sans Mono CJK");
});
