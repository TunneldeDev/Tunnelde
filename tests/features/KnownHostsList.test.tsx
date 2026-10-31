// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { entry, apiMock } = vi.hoisted(() => ({
  entry: {
    host: "example.com",
    port: 22,
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:abcdefghijklmnop",
    updatedAt: 1,
  },
  apiMock: {
    knownHostsList: vi.fn(),
    knownHostsForget: vi.fn(),
  },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));

import "@/i18n/i18n";
import { KnownHostsList } from "@/features/settings/KnownHostsList";

beforeEach(() => {
  apiMock.knownHostsList.mockResolvedValue([entry]);
  apiMock.knownHostsForget.mockResolvedValue(true);
});

describe("KnownHostsList", () => {
  it("lists trusted keys", async () => {
    render(<KnownHostsList />);
    expect(await screen.findByText("example.com:22")).toBeTruthy();
    expect(screen.getByText("ssh-ed25519")).toBeTruthy();
    expect(screen.getByText("SHA256:abcdefghijklmnop")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    apiMock.knownHostsList.mockResolvedValue([]);
    render(<KnownHostsList />);
    expect(await screen.findByText("No trusted hosts")).toBeTruthy();
  });

  it("filters by address and fingerprint", async () => {
    render(<KnownHostsList />);
    await screen.findByText("example.com:22");
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "unknown" } });
    expect(screen.queryByText("example.com:22")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.change(search, { target: { value: "SHA256:abc" } });
    expect(screen.getByText("example.com:22")).toBeTruthy();
  });

  it("can retry a failed load", async () => {
    apiMock.knownHostsList.mockRejectedValueOnce(new Error("offline"));
    render(<KnownHostsList />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("example.com:22")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
