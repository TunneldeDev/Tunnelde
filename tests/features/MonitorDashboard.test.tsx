import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { MonitorDashboard } from "@/features/monitor/components/MonitorDashboard";
import { habitStorage } from "@/lib/habits/storage";
import { viewIsBusy } from "@/lib/session/viewState";

const key = "tunnelde.panels.monitor-dashboard.h1.layout";
const ids = () =>
  [...document.querySelectorAll<HTMLElement>("[data-widget]")].map((e) => e.dataset.widget);
const stored = () => JSON.parse(localStorage.getItem(key)!);
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("en-US");
});
it("saves per-host order and dimensions, keeps chart DOM through moves, restores on remount and responds to habit resets", () => {
  const view = render(<MonitorDashboard hostId="h1" stats={null} samples={[]} />);
  const chart = screen.getByRole("slider", { name: "CPU history" });
  expect(screen.queryByRole("button", { name: /Resize CPU/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
  fireEvent.click(screen.getByRole("button", { name: "Move CPU later" }));
  expect(ids().slice(0, 2)).toEqual(["memory", "cpu"]);
  expect(screen.getByRole("slider", { name: "CPU history" })).toBe(chart);
  fireEvent.click(screen.getByRole("button", { name: "Reorder CPU · use Up/Down arrows" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Reorder CPU · use Up/Down arrows" }), {
    key: "ArrowUp",
  });
  expect(ids()[0]).toBe("cpu");
  const card = document.querySelector<HTMLElement>('[data-widget="cpu"]')!;
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ width: 500, height: 460 } as DOMRect);
  const resize = screen.getByRole("button", { name: /Resize CPU/ });
  resize.focus();
  fireEvent.keyDown(resize, { key: "ArrowDown" });
  expect(stored().widgets[0]).toMatchObject({ id: "cpu", columns: 6, height: 500 });
  expect(document.activeElement).toBe(resize);
  view.unmount();
  const second = render(<MonitorDashboard hostId="h1" stats={null} samples={[]} />);
  expect(
    document
      .querySelector<HTMLElement>('[data-widget="cpu"]')!
      .style.getPropertyValue("--widget-height"),
  ).toBe("500px");
  act(() => habitStorage.removeItem(key));
  expect(
    document
      .querySelector<HTMLElement>('[data-widget="cpu"]')!
      .style.getPropertyValue("--widget-height"),
  ).toBe("");
  second.rerender(<MonitorDashboard hostId="h2" stats={null} samples={[]} />);
  expect(ids()[0]).toBe("cpu");
});
it("commits resize only on release and rolls a preview back on Escape", () => {
  render(<MonitorDashboard hostId="h1" stats={null} samples={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
  const card = document.querySelector<HTMLElement>('[data-widget="cpu"]')!;
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ width: 500, height: 460 } as DOMRect);
  const handle = screen.getByRole("button", { name: /Resize CPU/ });
  const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(55);
  const pointer = (type: string, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: 500,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(type === "pointerdown" ? handle : window, event);
  };
  pointer("pointerdown", 460);
  expect(viewIsBusy()).toBe(true);
  pointer("pointermove", 600);
  act(() => frame.mock.calls.at(-1)![0](0));
  expect(card.style.getPropertyValue("--widget-height")).toBe("600px");
  expect(localStorage.getItem(key)).toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(card.style.getPropertyValue("--widget-height")).toBe("");
  expect(viewIsBusy()).toBe(false);
  pointer("pointerdown", 460);
  pointer("pointerup", 640);
  expect(stored().widgets[0].height).toBe(640);
  expect(viewIsBusy()).toBe(false);
});
it("shows persistence failures and rejects foreign drag data without changing layout", () => {
  render(<MonitorDashboard hostId="h1" stats={null} samples={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
  fireEvent.drop(document.querySelector('[data-widget="memory"]')!, {
    dataTransfer: { types: ["text/plain"] },
  });
  expect(localStorage.getItem(key)).toBeNull();
  vi.spyOn(habitStorage, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  fireEvent.click(screen.getByRole("button", { name: "Move CPU later" }));
  expect(screen.getByRole("alert").textContent).toContain("Could not save");
  expect(ids()[0]).toBe("cpu");
});

it("restores the previous dimensions when a pointer resize cannot be saved", () => {
  render(<MonitorDashboard hostId="h1" stats={null} samples={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit layout" }));
  const card = document.querySelector<HTMLElement>('[data-widget="cpu"]')!;
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ width: 500, height: 460 } as DOMRect);
  vi.spyOn(habitStorage, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  const handle = screen.getByRole("button", { name: /Resize CPU/ });
  const before = card.getAttribute("style");
  const event = (type: string, clientY: number) => {
    const pointer = new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientY,
    });
    Object.defineProperty(pointer, "pointerId", { value: 7 });
    fireEvent(type === "pointerdown" ? handle : window, pointer);
  };
  event("pointerdown", 460);
  event("pointerup", 600);
  expect(card.getAttribute("style")).toBe(before);
  expect(screen.getByRole("alert").textContent).toContain("Could not save");
  expect(localStorage.getItem(key)).toBeNull();
  expect(viewIsBusy()).toBe(false);
});
