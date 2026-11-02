import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@/i18n/i18n";
import { MonitorChart } from "@/features/monitor/MonitorChart";
import type { MonitorSample } from "@/store/monitorHistory";

const sample = (at: number, cpu: number): MonitorSample => ({
  at,
  cpu,
  memory: 50,
  disk: 20,
  rx: 2048,
  tx: 1024,
  diskRead: 4096,
  diskWrite: 8192,
});

describe("monitor timeline", () => {
  it("positions samples by elapsed time and exposes labeled horizontal scales", () => {
    const view = render(
      <MonitorChart
        samples={[sample(1000, 10), sample(2000, 20), sample(11000, 30)]}
        kind="cpu"
        label="CPU"
      />,
    );
    expect(view.container.querySelector("polyline")?.getAttribute("points")).toBe(
      "0.000,86.800 10.000,77.600 100.000,68.400",
    );
    expect(view.container.querySelectorAll(".monitor-chart__grid")).toHaveLength(5);
    for (const tick of ["100%", "75%", "50%", "25%", "0%"])
      expect(screen.getByText(tick)).toBeTruthy();
    expect(view.container.querySelectorAll(".monitor-chart__times time")).toHaveLength(2);
  });

  it("shows the nearest real sample on hover and supports keyboard inspection", () => {
    const samples = [sample(1000, 10), sample(2000, 20), sample(11000, 30)];
    const view = render(<MonitorChart samples={samples} kind="network" label="Network" />);
    const chart = screen.getByRole("slider", { name: "Network history" });
    chart.getBoundingClientRect = () => ({ left: 10, width: 100 }) as DOMRect;
    fireEvent.mouseMove(chart, { clientX: 20 });
    expect(chart.getAttribute("aria-valuenow")).toBe("1");
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Receive2.00 KB/s");
    expect(tooltip.textContent).toContain("Send1.00 KB/s");
    expect(tooltip.querySelector("time")?.dateTime).toBe(new Date(2000).toISOString());
    fireEvent.keyDown(chart, { key: "End" });
    expect(chart.getAttribute("aria-valuenow")).toBe("2");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(chart.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(chart.getAttribute("aria-valuenow")).toBe("1");
    view.rerender(
      <MonitorChart
        samples={[...samples.slice(1), sample(14000, 35)]}
        kind="network"
        label="Network"
      />,
    );
    expect(screen.getByRole("tooltip").querySelector("time")?.dateTime).toBe(
      new Date(2000).toISOString(),
    );
    fireEvent.mouseLeave(chart);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows separate read/write values and does not bridge missing disk measurements", () => {
    const samples = [
      sample(1000, 10),
      { ...sample(2000, 20), diskRead: null, diskWrite: null },
      sample(3000, 30),
    ];
    const view = render(<MonitorChart samples={samples} kind="disk" label="Disk I/O" />);
    expect(view.container.querySelectorAll("polyline")).toHaveLength(0);
    expect(view.container.querySelectorAll("circle")).toHaveLength(4);
    const chart = screen.getByRole("slider");
    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip").textContent).toContain("Read4.00 KB/s");
    expect(screen.getByRole("tooltip").textContent).toContain("Write8.00 KB/s");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("tooltip").textContent).toContain("Unavailable");
  });
});
