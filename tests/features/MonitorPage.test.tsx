// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { stats, apiMock } = vi.hoisted(() => ({
  stats: {
    cpuPercent: 42,
    cpuCount: 4,
    memoryUsed: 2 * 1024 * 1024 * 1024,
    memoryTotal: 4 * 1024 * 1024 * 1024,
    swapUsed: 0,
    swapTotal: 0,
    diskUsed: 50 * 1024 * 1024 * 1024,
    diskTotal: 100 * 1024 * 1024 * 1024,
    load: [0.1, 0.2, 0.3],
    uptime: 100,
    netRxRate: 2048,
    netTxRate: 1024,
    processes: [],
    sampledAt: 1,
  },
  apiMock: { remoteStats: vi.fn() },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));

import "@/i18n/i18n";
import { MonitorPage } from "@/features/monitor/MonitorPage";
import { useMonitorHistory } from "@/store/monitorHistory";
import { useSsh } from "@/store/ssh";

beforeEach(() => {
  apiMock.remoteStats.mockResolvedValue(stats);
  useMonitorHistory.setState({ samples: {} });
  useSsh.setState({
    sessions: [
      {
        id: "s1",
        hostId: "h1",
        title: "alpha",
        address: "root@alpha:22",
        cols: 120,
        rows: 32,
        connectedAt: 1,
      },
    ],
  });
});

describe("MonitorPage", () => {
  it("renders the live metrics and stores samples", async () => {
    render(<MonitorPage sessionId="s1" />);

    expect(await screen.findByText("alpha")).toBeTruthy();
    expect(await screen.findByText("42%")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();

    await waitFor(() => {
      expect(useMonitorHistory.getState().samples.s1?.length).toBeGreaterThan(0);
    });
    const sample = useMonitorHistory.getState().samples.s1?.[0];
    expect(sample?.cpu).toBeCloseTo(42);
    expect(sample?.memory).toBeCloseTo(50);
  });
});
