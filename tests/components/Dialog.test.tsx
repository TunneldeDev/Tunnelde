// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "@/components/ui/overlay/Dialog";
import { Select } from "@/components/ui/form/Select";

describe("Dialog keyboard and focus", () => {
  it("focuses a usable input and traps Tab while ignoring hidden and excluded controls", async () => {
    render(
      <Dialog
        open
        title="New host"
        closeLabel="Close"
        onClose={vi.fn()}
        footer={<button>Save</button>}
      >
        <input type="hidden" aria-label="Internal" />
        <input aria-label="Name" />
        <button tabIndex={-1}>Not in tab order</button>
        <div style={{ display: "none" }}>
          <button>Hidden</button>
        </div>
        <div aria-hidden="true">
          <button>Invisible</button>
        </div>
      </Dialog>,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });
    act(() => save.focus());
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it("recovers focus from outside and restores the opener on close", async () => {
    const { rerender } = render(<button>Open</button>);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    rerender(
      <>
        <button>Open</button>
        <Dialog open title="Settings" closeLabel="Close" onClose={vi.fn()}>
          <button>Action</button>
        </Dialog>
      </>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })),
    );
    act(() => opener.focus());
    fireEvent.keyDown(opener, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Action" }));
    rerender(<button>Open</button>);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps focus inside a dialog with no enabled controls and respects dismissible", async () => {
    const close = vi.fn();
    render(
      <Dialog open title="Working" closeLabel="Close" onClose={close} dismissible={false}>
        <input type="hidden" />
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(panel));
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: "Escape" });
    fireEvent.mouseDown(panel.parentElement!);
    expect(close).not.toHaveBeenCalled();
  });

  it("restores the opener even when an input uses React autoFocus", () => {
    const { rerender } = render(<button>Open</button>);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    rerender(
      <>
        <button>Open</button>
        <Dialog open title="New host" closeLabel="Close" onClose={vi.fn()}>
          <input autoFocus aria-label="Name" />
        </Dialog>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    rerender(<button>Open</button>);
    expect(document.activeElement).toBe(opener);
  });

  it("lets only the top dialog handle Escape when another dialog is behind it", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    render(
      <>
        <Dialog open title="Lower" closeLabel="Close lower" onClose={lower}>
          <input aria-label="Lower input" />
        </Dialog>
        <Dialog open title="Upper" closeLabel="Close upper" onClose={upper}>
          <input aria-label="Upper input" />
        </Dialog>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Upper input" }), { key: "Escape" });
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });

  it("uses Escape to dismiss a child Select before closing the dialog", () => {
    const close = vi.fn();
    render(
      <Dialog open title="Settings" closeLabel="Close" onClose={close}>
        <Select
          label="Language"
          value="en"
          options={[
            { value: "en", label: "English" },
            { value: "zh", label: "Chinese" },
          ]}
          onChange={vi.fn()}
        />
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Language" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape used by the input method and unrelated page popups", () => {
    const close = vi.fn();
    render(
      <>
        <div className="td-select__popup">Background dropdown</div>
        <Dialog open title="Edit" closeLabel="Close" onClose={close}>
          <input aria-label="Name" />
        </Dialog>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
