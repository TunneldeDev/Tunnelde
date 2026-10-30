// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

const { reorder } = vi.hoisted(() => ({ reorder: vi.fn() }));

vi.mock("@/lib/api/ipc", () => ({
  api: {
    hostsReorder: reorder,
    hostsSnapshot: vi.fn(),
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
  useHosts.setState({ hosts: [host("alpha", 0), host("beta", 1), host("gamma", 2)] });
});

describe("host ordering", () => {
  it("moves a host in front of the drop target", () => {
    useHosts.getState().moveHost("gamma", "alpha");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(reorder).toHaveBeenCalledWith(["gamma", "alpha", "beta"]);
  });

  it("ignores a drop on itself or an unknown target", () => {
    useHosts.getState().moveHost("alpha", "alpha");
    useHosts.getState().moveHost("alpha", "missing");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(reorder).not.toHaveBeenCalled();
  });
});
