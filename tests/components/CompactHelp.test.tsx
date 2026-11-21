import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Field, Input } from "@/components/ui/form/Field";
import { HelpHint } from "@/components/ui/form/HelpHint";
import { PasswordInput } from "@/components/ui/form/PasswordInput";
import { SwitchRow } from "@/components/ui/form/Switch";
import { Dialog } from "@/components/ui/overlay/Dialog";
import i18n from "@/i18n/i18n";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => vi.useRealTimers());

function Example({ close = vi.fn() }: { close?: () => void }) {
  return (
    <Dialog open title="Export" closeLabel="Close" onClose={close}>
      <Field label="Password" htmlFor="secret" hint="Choose a secret">
        <Input id="secret" />
      </Field>
      <SwitchRow checked={false} label="Credentials" hint="Includes keys" onChange={vi.fn()} />
    </Dialog>
  );
}

describe("contextual help", () => {
  it("keeps full-page explanations inline", () => {
    render(
      <Field label="Name" hint="An explanation">
        <Input />
      </Field>,
    );
    expect(screen.getByText("An explanation").className).toBe("td-field__hint");
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("places dialog hints beside labels with persistent accessible descriptions", () => {
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Help: Password" });
    const description = document.getElementById(trigger.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("Choose a secret");
    expect(screen.getByText("Choose a secret").className).toBe("td-sr-only");
    expect(screen.getByText("Includes keys").className).toBe("td-sr-only");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe("Choose a secret");
  });
  it("never toggles a switch when requesting its help, including disabled controls", () => {
    const onChange = vi.fn();
    render(
      <Dialog open title="Options" closeLabel="Close" onClose={vi.fn()}>
        <SwitchRow label="Protected" checked hint="Why disabled" disabled onChange={onChange} />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help: Protected" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("tooltip").textContent).toBe("Why disabled");
  });
  it("can explicitly keep important explanations visible inside dialogs", () => {
    render(
      <Dialog open title="Options" closeLabel="Close" onClose={vi.fn()}>
        <Field label="Danger" hint="Do not lose this" hintPresentation="inline" error="Required">
          <Input />
        </Field>
        <SwitchRow
          label="Consent"
          checked={false}
          onChange={vi.fn()}
          hint="A visible warning"
          hintPresentation="inline"
        />
      </Dialog>,
    );
    expect(screen.getByText("Required").className).toBe("td-field__error");
    expect(screen.getByText("A visible warning").className).toBe("td-switch-row__hint");
    expect(screen.queryByRole("button", { name: "Help: Consent" })).toBeNull();
  });
  it("dismisses help with Escape before closing the dialog", () => {
    const close = vi.fn();
    render(<Example close={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Help: Password" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("delays hover, cancels on leave and allows moving onto the bubble", () => {
    vi.useFakeTimers();
    render(<HelpHint label="Name">Explanation</HelpHint>);
    const anchor = screen.getByRole("button").parentElement!;
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(349));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const bubble = screen.getByRole("tooltip");
    fireEvent.pointerLeave(anchor);
    fireEvent.pointerEnter(bubble);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole("tooltip")).toBe(bubble);
    fireEvent.pointerLeave(bubble);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("shows one tooltip at a time and supports click/outside dismissal", () => {
    render(
      <>
        <HelpHint label="First">One</HelpHint>
        <HelpHint label="Second">Two</HelpHint>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help: First" }));
    fireEvent.click(screen.getByRole("button", { name: "Help: Second" }));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip").textContent).toBe("Two");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("keeps the tooltip inside viewport edges and above a bottom-edge trigger", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return (
          this.classList.contains("td-tooltip")
            ? { left: 0, top: 0, width: 250, height: 80, bottom: 80, right: 250 }
            : { left: 1000, top: 740, width: 20, height: 20, bottom: 760, right: 1020 }
        ) as DOMRect;
      });
    render(<HelpHint label="Edge">Explanation</HelpHint>);
    fireEvent.click(screen.getByRole("button"));
    const tip = screen.getByRole("tooltip");
    expect(parseFloat(tip.style.left)).toBeLessThanOrEqual(window.innerWidth - 250 - 8);
    expect(parseFloat(tip.style.top)).toBe(652);
    expect(tip.parentElement).toBe(document.body);
    rect.mockRestore();
  });
  it("unmounts open bubbles and cancels pending hover", () => {
    vi.useFakeTimers();
    const { unmount } = render(<HelpHint label="Name">Explanation</HelpHint>);
    fireEvent.pointerEnter(screen.getByRole("button").parentElement!);
    unmount();
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("password field", () => {
  it("reveals without changing value or submitting its form", () => {
    const submit = vi.fn();
    render(
      <form onSubmit={submit}>
        <PasswordInput aria-label="Secret" defaultValue="password" />
      </form>,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Secret");
    input.focus();
    input.setSelectionRange(2, 4);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");
    expect(input.value).toBe("password");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.type).toBe("password");
    expect(submit).not.toHaveBeenCalled();
  });
  it("honors controlled reveal, copy and disabled states", () => {
    const reveal = vi.fn(),
      copy = vi.fn();
    const { rerender } = render(
      <PasswordInput
        aria-label="Secret"
        value="abc"
        readOnly
        revealed
        onRevealedChange={reveal}
        onCopy={copy}
        copyLabel="Copy secret"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(reveal).toHaveBeenCalledWith(false);
    expect(screen.getByLabelText<HTMLInputElement>("Secret").type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));
    expect(copy).toHaveBeenCalledOnce();
    rerender(
      <PasswordInput
        aria-label="Secret"
        value="abc"
        readOnly
        disabled
        onCopy={copy}
        copyLabel="Copy secret"
      />,
    );
    for (const button of within(
      screen.getByLabelText("Secret").parentElement!,
    ).getAllByRole<HTMLButtonElement>("button")) {
      expect(button.disabled).toBe(true);
    }
  });
});
