// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { SAMPLE_LIMIT, summarize, useMonitorHistory } from "@/store/monitorHistory";

const sample = (cpu: number) => ({
  at: 0,
  cpu,
  memory: 0,
  disk: 0,
  rx: 0,
  tx: 0,
});

describe("monitor history", () => {
  it("keeps the newest samples within the limit", () => {
    useMonitorHistory.getState().clear("s1");
    for (let index = 0; index < SAMPLE_LIMIT + 5; index += 1) {
      useMonitorHistory.getState().push("s1", sample(index));
    }
    const samples = useMonitorHistory.getState().samples.s1 ?? [];
    expect(samples).toHaveLength(SAMPLE_LIMIT);
    expect(samples[samples.length - 1]?.cpu).toBe(SAMPLE_LIMIT + 4);
  });

  it("clears a session", () => {
    useMonitorHistory.getState().push("s2", sample(10));
    useMonitorHistory.getState().clear("s2");
    expect(useMonitorHistory.getState().samples.s2).toBeUndefined();
  });

  it("summarizes values", () => {
    expect(summarize([])).toEqual({ min: 0, max: 0, average: 0 });
    expect(summarize([10, 20, 30])).toEqual({ min: 10, max: 30, average: 20 });
  });
});
