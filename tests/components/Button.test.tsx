// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button, IconButton } from "@/components/ui/Button";

describe("Button", () => {
  it("applies the variant class", () => {
    render(<Button variant="primary">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toContain("td-btn--primary");
  });

  it("calls the handler", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);
    screen.getByRole("button", { name: "Run" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("IconButton", () => {
  it("exposes the label for assistive tech", () => {
    render(
      <IconButton label="Close tab">
        <span />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
  });

  it("marks the pressed state", () => {
    render(
      <IconButton label="Panel" active>
        <span />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Panel" }).getAttribute("aria-pressed")).toBe("true");
  });
});
