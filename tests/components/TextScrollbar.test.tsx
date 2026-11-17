import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TextScrollbar, trackScrollVelocity } from "@/components/ui/display/TextScrollbar";

let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const flushFrame = (time = 16) =>
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  });
const pointer = (
  type: string,
  clientY: number,
  pointerId = 1,
  button = 0,
  buttons = type === "pointermove" || type === "pointerdown" ? 1 : 0,
) => {
  const event = new MouseEvent(type, { bubbles: true, clientY, button, buttons });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
};

function Harness() {
  const target = useRef<HTMLTextAreaElement>(null);
  return (
    <div style={{ position: "relative", height: 200 }}>
      <textarea ref={target} aria-label="Source" defaultValue={"line\n".repeat(100)} />
      <TextScrollbar target={target} />
    </div>
  );
}

let replaceContent: ((value: string) => void) | undefined;

function ControlledHarness({ onReady }: { onReady: (replace: (value: string) => void) => void }) {
  const target = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("short");
  useEffect(() => onReady(setValue), [onReady]);
  return (
    <div style={{ position: "relative", height: 200 }}>
      <textarea ref={target} aria-label="Controlled source" value={value} readOnly />
      <TextScrollbar target={target} />
    </div>
  );
}

beforeEach(() => {
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

describe("TextScrollbar", () => {
  it("maps distance from the thumb to a bounded, direction-aware velocity", () => {
    expect(trackScrollVelocity(20, 0, 40, 40, 400).direction).toBe(-1);
    expect(trackScrollVelocity(20, 0, 40, 40, 400).velocity).toBeCloseTo(770);
    expect(trackScrollVelocity(90, 0, 40, 40, 400).direction).toBe(1);
    expect(trackScrollVelocity(90, 0, 40, 40, 400).velocity).toBeCloseTo(179.375);
    expect(trackScrollVelocity(60, 0, 40, 40, 400)).toEqual({
      direction: 0,
      velocity: 0,
    });
    expect(trackScrollVelocity(80.1, 0, 40, 40, 400).direction).toBe(1);
    expect(trackScrollVelocity(80.1, 0, 40, 40, 400).velocity).toBeCloseTo(140.39375);
  });

  it("scrolls continuously while the blank track is held and stops on release", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Source" }) as HTMLTextAreaElement;
    const track = textarea.parentElement!.querySelector<HTMLElement>(".td-text-scrollbar")!;
    const thumb = track.querySelector<HTMLElement>(".td-text-scrollbar__thumb")!;
    Object.defineProperties(textarea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    Object.defineProperties(track, {
      clientHeight: { configurable: true, value: 200 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, height: 200 }),
      },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    Object.defineProperties(thumb, {
      offsetHeight: { configurable: true, value: 40 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 80, height: 40 }),
      },
    });
    fireEvent(track, pointer("pointerdown", 180));
    expect(textarea.scrollTop).toBeGreaterThan(200);
    const first = textarea.scrollTop;
    flushFrame(performance.now() + 32);
    expect(textarea.scrollTop).toBeGreaterThan(first);
    fireEvent(track, pointer("pointerup", 180));
    const released = textarea.scrollTop;
    flushFrame(64);
    expect(textarea.scrollTop).toBe(released);
  });

  it("drags the thumb to an absolute position without starting track autoscroll", () => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Source" }) as HTMLTextAreaElement;
    const track = textarea.parentElement!.querySelector<HTMLElement>(".td-text-scrollbar")!;
    const thumb = track.querySelector<HTMLElement>(".td-text-scrollbar__thumb")!;
    Object.defineProperties(textarea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    Object.defineProperties(track, {
      clientHeight: { configurable: true, value: 200 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, height: 200 }),
      },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    Object.defineProperties(thumb, {
      offsetHeight: { configurable: true, value: 40 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, height: 40 }),
      },
    });
    fireEvent(track, pointer("pointerdown", 10));
    expect(track.hasAttribute("data-dragging")).toBe(true);
    fireEvent(track, pointer("pointermove", 120));
    expect(textarea.scrollTop).toBe(550);
    expect(frames.size).toBe(0);
    fireEvent(track, pointer("pointerup", 120));
    expect(track.hasAttribute("data-dragging")).toBe(false);
  });

  it("refreshes after a controlled value replacement without an input or scroll event", () => {
    const onReady = (replace: (value: string) => void) => {
      replaceContent = replace;
    };
    render(<ControlledHarness onReady={onReady} />);
    const textarea = screen.getByRole("textbox", {
      name: "Controlled source",
    }) as HTMLTextAreaElement;
    const track = textarea.parentElement!.querySelector<HTMLElement>(".td-text-scrollbar")!;
    let scrollHeight = 200;
    Object.defineProperties(textarea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    expect(track.hidden).toBe(true);

    act(() => {
      scrollHeight = 24842;
      replaceContent?.("line\n".repeat(1000));
    });

    expect(track.hidden).toBe(false);
    expect(track.querySelector<HTMLElement>(".td-text-scrollbar__thumb")?.style.height).toBe(
      "24px",
    );
  });

  it.each([
    [0, 100, 100],
    [1, 3, 48],
    [2, 1, 200],
  ])("forwards wheel delta mode %i over the track", (deltaMode, deltaY, expected) => {
    render(<Harness />);
    const textarea = screen.getByRole("textbox", { name: "Source" }) as HTMLTextAreaElement;
    const track = textarea.parentElement!.querySelector<HTMLElement>(".td-text-scrollbar")!;
    Object.defineProperties(textarea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    const event = new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true });
    fireEvent(track, event);

    expect(textarea.scrollTop).toBe(expected);
    expect(event.defaultPrevented).toBe(true);
  });
});
