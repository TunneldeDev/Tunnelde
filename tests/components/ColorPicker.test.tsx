import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { ColorPicker } from "@/components/ui/form/ColorPicker";
import { Dialog } from "@/components/ui/overlay/Dialog";

let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const flushFrame = () =>
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Accent" }));
const hexInput = () => screen.getByRole("textbox", { name: "HEX" });

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  frames.clear();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("ColorPicker drafts and persistence", () => {
  it("rejects incomplete HEX then commits one normalized color only on Apply", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Accent" value="#123456" onChange={onChange} />);
    openPicker();
    fireEvent.change(hexInput(), { target: { value: "#12" } });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(hexInput(), { target: { value: "AbC" } });
    expect((screen.getByRole("spinbutton", { name: "Red" }) as HTMLInputElement).value).toBe("170");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("#aabbcc");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("validates all RGB channels and synchronizes the HEX draft", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Accent" value="#000000" onChange={onChange} />);
    openPicker();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Red" }), { target: { value: "256" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Blue" }), {
      target: { value: "128" },
    });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Red" }), { target: { value: "255" } });
    expect((hexInput() as HTMLInputElement).value).toBe("#ff0080");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("#ff0080");
  });

  it("coalesces preview updates per animation frame and cleans up Cancel", () => {
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(
      <ColorPicker label="Accent" value="#123456" onChange={onChange} onPreview={onPreview} />,
    );
    openPicker();
    flushFrame();
    onPreview.mockClear();
    for (const color of ["#ffffff", "#aabbcc", "#102030"])
      fireEvent.change(hexInput(), { target: { value: color } });
    expect(onPreview).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    flushFrame();
    expect(onPreview).toHaveBeenCalledExactlyOnceWith("#102030");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(onChange).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("retains preset IDs and keeps Reset local until Apply", () => {
    const onChange = vi.fn();
    render(
      <ColorPicker
        label="Accent"
        value="blue"
        defaultValue="blue"
        presets={[
          { value: "blue", color: "#123456", label: "Ocean" },
          { value: "green", color: "#00ff00", label: "Forest" },
        ]}
        onChange={onChange}
      />,
    );
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Forest" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset color" }));
    expect(screen.getByRole("button", { name: "Ocean" }).getAttribute("aria-pressed")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Forest" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("green");
  });

  it("Escape closes only the nested picker and restores trigger focus", () => {
    const closeHost = vi.fn();
    const onChange = vi.fn();
    const onPreview = vi.fn();
    render(
      <Dialog open title="Host" closeLabel="Close host" onClose={closeHost}>
        <ColorPicker label="Accent" value="#123456" onChange={onChange} onPreview={onPreview} />
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Accent" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.change(hexInput(), { target: { value: "#aabbcc" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Accent" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Host" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    expect(closeHost).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("supports pointer and keyboard adjustment without saving", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const onChange = vi.fn();
    render(<ColorPicker label="Accent" value="#ff0000" onChange={onChange} />);
    openPicker();
    const area = screen.getByRole("slider", { name: "Saturation and brightness" });
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
    } as DOMRect);
    fireEvent.pointerDown(area, { clientX: 100, clientY: 50 });
    expect((hexInput() as HTMLInputElement).value).toBe("#804040");
    fireEvent.pointerMove(area, { clientX: 300, clientY: -50 });
    fireEvent.pointerUp(area);
    expect((hexInput() as HTMLInputElement).value).toBe("#ff0000");
    fireEvent.keyDown(area, { key: "Home" });
    expect((hexInput() as HTMLInputElement).value).toBe("#ffffff");
    fireEvent.keyDown(area, { key: "ArrowDown", shiftKey: true });
    expect((hexInput() as HTMLInputElement).value).toBe("#e6e6e6");
    fireEvent.change(screen.getByRole("slider", { name: "Hue" }), { target: { value: "240" } });
    fireEvent.keyDown(area, { key: "End" });
    expect((hexInput() as HTMLInputElement).value).toBe("#0000e6");
    expect(onChange).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" })).toBeTruthy();
  });
});
