// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteProcess } from "@/lib/api/types";

const { remoteProcesses } = vi.hoisted(() => ({ remoteProcesses: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { remoteProcesses } }));
import "@/i18n/i18n";
import { ProcessesDialog } from "@/features/monitor/ProcessesDialog";

describe("process list request ownership", () => {
  it("does not show processes from a previous server or accept its late result", async () => {
    let first!: (items: RemoteProcess[]) => void;
    let second!: (items: RemoteProcess[]) => void;
    remoteProcesses
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            second = resolve;
          }),
      );
    const view = render(<ProcessesDialog sessionId="old" onClose={() => undefined} />);
    await waitFor(() => expect(remoteProcesses).toHaveBeenCalledWith("old"));
    view.rerender(<ProcessesDialog sessionId="new" onClose={() => undefined} />);
    await waitFor(() => expect(remoteProcesses).toHaveBeenCalledWith("new"));
    await act(async () =>
      second([{ pid: 42, name: "new-server-process", cpu: 1, memory: 1, rss: 1024 }]),
    );
    expect(await screen.findByText("new-server-process")).toBeTruthy();
    await act(async () =>
      first([{ pid: 43, name: "old-server-process", cpu: 1, memory: 1, rss: 1024 }]),
    );
    expect(screen.queryByText("old-server-process")).toBeNull();
    expect(screen.getByText("new-server-process")).toBeTruthy();
  });
});
