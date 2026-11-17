import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n/i18n";
import { FileViewMenu } from "@/features/sftp/FileViewMenu";
import type { FileViewPreferences } from "@/lib/files/view";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("FileViewMenu", () => {
  it("renders every selection with a trailing check and matching menu semantics", () => {
    const view: FileViewPreferences = {
      filesLayout: "columns",
      filesShowHidden: true,
      filesFoldersFirst: false,
      filesColumns: ["name", "size"],
      filesSortBy: "name",
      filesSortDirection: "asc",
      filesGroupBy: "type",
    };
    render(<FileViewMenu view={view} onChange={vi.fn()} onReset={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "View options" }));

    const radio = (name: string) => screen.getByRole("menuitemradio", { name });
    const checkbox = (name: string) => screen.getByRole("menuitemcheckbox", { name });

    expect(radio("Column view").getAttribute("aria-checked")).toBe("true");
    expect(radio("Details view").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Show hidden files").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Folders first").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Show column: Size").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Show column: Type").getAttribute("aria-checked")).toBe("false");
    expect(radio("Name").getAttribute("aria-checked")).toBe("true");
    expect(radio("Ascending").getAttribute("aria-checked")).toBe("true");
    expect(radio("Group by type").getAttribute("aria-checked")).toBe("true");

    const checks = [...document.querySelectorAll<SVGElement>(".td-menu__check")];
    const selected = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"], [role="menuitemcheckbox"]',
      ),
    ].filter((item) => item.getAttribute("aria-checked") === "true");
    expect(checks).toHaveLength(selected.length);
    expect(checks.every((check) => check.parentElement?.lastElementChild === check)).toBe(true);
    expect(document.querySelector(".td-menu__icon")).toBeNull();
  });
});
