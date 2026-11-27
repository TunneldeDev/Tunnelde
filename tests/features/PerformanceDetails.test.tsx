import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import i18n from "@/i18n/i18n";
import { PerformanceDetails } from "@/features/monitor/components/PerformanceDetails";
import type { RemoteStats } from "@/lib/api/types";
import type { PerformanceDetails as Details } from "@/lib/api/performance";
afterEach(cleanup);
it("shows real CPU counts, frequency, memory and device details without fabricating missing metrics", async () => {
  await i18n.changeLanguage("en-US");
  const details: Details = {
    cpuModel: "Test CPU",
    cpuMhz: 2400,
    baseMhz: null,
    maxMhz: 3600,
    sockets: 1,
    cores: 4,
    cache: "8192 KB",
    processes: 230,
    threads: 456,
    fileHandles: 789,
    fileHandleLimit: 9999,
    memoryAvailable: 1024,
    memoryCached: 2048,
    memoryBuffers: null,
    memorySlab: 4096,
    memoryCommitted: null,
    memoryCommitLimit: null,
    pageTables: null,
    kernelStack: null,
    logicalCpus: [
      { name: "cpu0", percent: 42 },
      { name: "cpu1", percent: null },
    ],
    disks: [
      {
        name: "nvme0n1",
        model: "Fast disk",
        capacity: 1048576,
        rotational: false,
        activePercent: 25,
        responseMs: 2.5,
        readRate: 1024,
        writeRate: null,
      },
    ],
    networks: [
      {
        name: "eth0",
        rxRate: 4096,
        txRate: 8192,
        speedMbps: 1000,
        mac: "aa:bb:cc",
        state: "up",
        addresses: ["192.0.2.1/24", "2001:db8::1/64"],
      },
    ],
    gpus: [],
  };
  render(<PerformanceDetails stats={{ details, cpuCount: 8, uptime: 100 } as RemoteStats} />);
  const cpu = screen.getByRole("region", { name: "CPU details" });
  for (const text of ["Test CPU", "2.40 GHz", "230", "456", "789", "42%"])
    expect(within(cpu).getByText(text)).toBeTruthy();
  expect(within(cpu).getAllByText("—").length).toBeGreaterThan(1);
  expect(screen.getByText("2.50 ms")).toBeTruthy();
  expect(screen.getByText("1000 Mbps")).toBeTruthy();
  expect(screen.getByText("192.0.2.1/24 · 2001:db8::1/64")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "GPU details" })).getByText("Unavailable"),
  ).toBeTruthy();
});
it("supports older native samples without details", async () => {
  await i18n.changeLanguage("en-US");
  render(<PerformanceDetails stats={null} />);
  expect(screen.getAllByText("—").length).toBeGreaterThan(20);
  expect(screen.queryByText("0.00 GHz")).toBeNull();
});
