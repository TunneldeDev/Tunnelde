import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n/i18n";
import { WelcomePage } from "@/features/welcome/WelcomePage";
import { api } from "@/lib/api/ipc";
import type { SshConfigEntry, SshConfigPreview } from "@/lib/api/sshConfig";
import type { Host } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";
import { useToasts } from "@/store/toasts";

const entry = (alias: string, patch: Partial<SshConfigEntry> = {}): SshConfigEntry => ({
  alias,
  input: {
    name: alias,
    host: `${alias}.example.com`,
    username: "alice",
    port: 22,
    authMethod: "agent",
  },
  jumpAliases: [],
  issues: [],
  existingId: null,
  ...patch,
});
const preview = (entries = [entry("production")]): SshConfigPreview => ({
  path: "/fixture/.ssh/config",
  found: true,
  revision: "config-revision-1",
  entries,
  issues: [],
});
const saved: Host = {
  id: "imported-production",
  name: "production",
  host: "production.example.com",
  port: 22,
  username: "alice",
  authMethod: "agent",
  keyPath: null,
  groupId: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useHosts.setState({ hosts: [], groups: [], loading: false });
  useToasts.setState({ items: [] });
  vi.spyOn(api, "sshConfigPreview").mockResolvedValue(preview());
  vi.spyOn(api, "sshConfigImport").mockResolvedValue({ imported: [saved], skipped: 0 });
  vi.spyOn(api, "hostsSnapshot").mockResolvedValue({ hosts: [saved], groups: [] });
});

async function openImport() {
  render(<WelcomePage />);
  fireEvent.click(screen.getByRole("button", { name: "Import SSH config" }));
  return screen.findByRole("checkbox", { name: /production/ });
}

describe("SSH config import", () => {
  it("guides welcome users to the local config and imports the selected preview revision", async () => {
    const checkbox = await openImport();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("/fixture/.ssh/config")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
    await waitFor(() =>
      expect(api.sshConfigImport).toHaveBeenCalledWith(["production"], "config-revision-1"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useHosts.getState().hosts).toEqual([saved]);
    expect(useToasts.getState().items.some((item) => item.message === "Imported 1 host")).toBe(
      true,
    );
  });

  it("keeps existing and unsupported entries out of the imported selection", async () => {
    vi.mocked(api.sshConfigPreview).mockResolvedValue(
      preview([
        entry("production", { jumpAliases: ["bastion"] }),
        entry("bastion", { existingId: "saved-bastion" }),
        entry("legacy", {
          input: null,
          issues: [{ code: "unsupportedOption", detail: "ProxyCommand" }],
        }),
      ]),
    );
    await openImport();
    const existing = screen.getByRole("checkbox", {
      name: /bastion.*Already imported/,
    }) as HTMLInputElement;
    const unsupported = screen.getByRole("checkbox", {
      name: /legacy.*ProxyCommand/,
    }) as HTMLInputElement;
    expect(existing.disabled).toBe(true);
    expect(unsupported.disabled).toBe(true);
    expect(screen.getByText(/Required jump hosts are imported/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
    await waitFor(() =>
      expect(api.sshConfigImport).toHaveBeenCalledWith(["production"], "config-revision-1"),
    );
  });

  it("allows selection without changing or overwriting the source config", async () => {
    vi.mocked(api.sshConfigPreview).mockResolvedValue(
      preview([entry("production"), entry("staging")]),
    );
    await openImport();
    fireEvent.click(screen.getByRole("checkbox", { name: /staging/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
    await waitFor(() =>
      expect(api.sshConfigImport).toHaveBeenCalledWith(["production"], "config-revision-1"),
    );
  });

  it.each([
    [false, "No SSH config was found on this computer."],
    [true, "No named hosts were found in this config."],
  ])("shows an actionable empty state when found=%s", async (found, message) => {
    vi.mocked(api.sshConfigPreview).mockResolvedValue({ ...preview([]), found });
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Import SSH config" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Import selected (0)" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.sshConfigImport).not.toHaveBeenCalled();
  });

  it("retains the preview on failure and refreshes a stale config before retrying", async () => {
    vi.mocked(api.sshConfigImport).mockRejectedValueOnce({
      code: "validation",
      message: "sshImport.changed",
    });
    await openImport();
    fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The SSH config has changed. Refresh the preview and try again.",
    );
    expect(useHosts.getState().hosts).toEqual([]);
    vi.mocked(api.sshConfigPreview).mockResolvedValue({
      ...preview(),
      revision: "config-revision-2",
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.sshConfigPreview).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Import selected (1)" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
    await waitFor(() =>
      expect(api.sshConfigImport).toHaveBeenLastCalledWith(["production"], "config-revision-2"),
    );
  });

  it("prevents duplicate commits while an import is in flight", async () => {
    let finish!: (value: { imported: Host[]; skipped: number }) => void;
    vi.mocked(api.sshConfigImport).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await openImport();
    const importButton = screen.getByRole("button", { name: "Import selected (1)" });
    fireEvent.click(importButton);
    fireEvent.click(importButton);
    expect(api.sshConfigImport).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish({ imported: [saved], skipped: 0 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not apply a late preview after the user closes it", async () => {
    let finish!: (value: SshConfigPreview) => void;
    vi.mocked(api.sshConfigPreview).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Import SSH config" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => finish(preview()));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.sshConfigImport).not.toHaveBeenCalled();
    expect(useHosts.getState().hosts).toEqual([]);
  });
});
