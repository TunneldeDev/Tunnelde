// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

const { reorder, update, snapshot } = vi.hoisted(() => ({
  reorder: vi.fn(),
  update: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@/lib/api/ipc", () => ({
  api: {
    hostsReorder: reorder,
    hostsSnapshot: snapshot,
    updateHost: update,
  },
}));

import "@/i18n/i18n";
import type { Host } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";

const host = (id: string, sortOrder: number): Host => ({
  id,
  groupId: null,
  name: id,
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  reorder.mockReset().mockResolvedValue(undefined);
  update.mockReset().mockResolvedValue(undefined);
  snapshot.mockReset();
  useHosts.setState({ hosts: [host("alpha", 0), host("beta", 1), host("gamma", 2)] });
});

describe("host ordering", () => {
  it("moves a host in front of the drop target", () => {
    useHosts.getState().moveHost("gamma", "alpha");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["gamma", "alpha", "beta"]);
    expect(reorder).toHaveBeenCalledWith(["gamma", "alpha", "beta"]);
  });

  it("ignores a drop on itself or an unknown target", () => {
    useHosts.getState().moveHost("alpha", "alpha");
    useHosts.getState().moveHost("alpha", "missing");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("inserts after the target and adopts its group", async () => {
    useHosts.setState({
      hosts: [{ ...host("alpha", 0), groupId: "g1" }, host("beta", 1), host("gamma", 2)],
    });
    useHosts.getState().moveHost("gamma", "alpha", "after");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["alpha", "gamma", "beta"]);
    expect(useHosts.getState().hosts.find((item) => item.id === "gamma")?.groupId).toBe("g1");
    expect(update).toHaveBeenCalledWith("gamma", expect.objectContaining({ groupId: "g1" }));
    await vi.waitFor(() => expect(reorder).toHaveBeenCalledWith(["alpha", "gamma", "beta"]));
  });

  it("serializes rapid drops while keeping the newest visible order", async () => {
    let finish!: () => void;
    reorder.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    useHosts.getState().moveHost("gamma", "alpha");
    useHosts.getState().moveHost("beta", "gamma");
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["beta", "gamma", "alpha"]);
    finish();
    await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(2));
    expect(reorder).toHaveBeenLastCalledWith(["beta", "gamma", "alpha"]);
  });

  it("does not let an old snapshot undo a later drag", async () => {
    let finish!: (value: { groups: []; hosts: Host[] }) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const loading = useHosts.getState().load();
    useHosts.getState().moveHost("gamma", "alpha");
    finish({ groups: [], hosts: [host("alpha", 0), host("beta", 1), host("gamma", 2)] });
    await loading;
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["gamma", "alpha", "beta"]);
  });
});
