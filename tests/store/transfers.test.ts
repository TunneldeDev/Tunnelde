// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import { useTransfers } from "@/store/transfers";
import type { TransferEvent } from "@/lib/api/types";

const running: TransferEvent = {
  id: "transfer",
  direction: "transfer",
  name: "file.txt",
  transferred: 0,
  total: 100,
  status: "running",
  error: null,
};

beforeEach(() => useTransfers.setState({ items: [] }));

describe("transfer cancellation", () => {
  it("waits for the backend result and retains cancellation during progress updates", () => {
    vi.spyOn(api, "transferCancel").mockResolvedValue(undefined);
    const store = useTransfers.getState();
    store.apply(running);
    store.cancel(running.id);
    store.cancel(running.id);
    expect(api.transferCancel).toHaveBeenCalledTimes(1);
    expect(useTransfers.getState().items[0]).toMatchObject({ status: "running", cancelling: true });
    store.apply({ ...running, transferred: 50 });
    expect(useTransfers.getState().items[0]?.cancelling).toBe(true);
    store.apply({ ...running, status: "cancelled", transferred: 50 });
    expect(useTransfers.getState().items[0]).toMatchObject({ status: "cancelled" });
    store.apply({ ...running, transferred: 20 });
    expect(useTransfers.getState().items[0]?.status).toBe("cancelled");
  });

  it("allows retry when the cancellation request fails", async () => {
    vi.spyOn(api, "transferCancel").mockRejectedValue(new Error("Could not cancel"));
    useTransfers.getState().apply(running);
    await act(async () => useTransfers.getState().cancel(running.id));
    expect(useTransfers.getState().items[0]).toMatchObject({
      status: "running",
      cancelling: false,
    });
  });
});
