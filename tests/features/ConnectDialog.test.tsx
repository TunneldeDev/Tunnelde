// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    sshProbe: vi.fn(),
    sshTrust: vi.fn(),
    credentialStatus: vi.fn(),
    credentialSave: vi.fn(),
    credentialForget: vi.fn(),
    sshInstallKey: vi.fn(),
    hostsSnapshot: vi.fn(),
  },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));

import "@/i18n/i18n";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";

const host: Host = {
  id: "host-1",
  groupId: null,
  name: "web-01",
  host: "10.0.0.5",
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  apiMock.sshProbe.mockReset().mockResolvedValue({
    fingerprint: "SHA256:abc",
    algorithm: "ssh-ed25519",
    status: "known",
    knownFingerprint: "SHA256:abc",
  });
  apiMock.credentialStatus.mockReset().mockResolvedValue(false);
  apiMock.credentialSave.mockReset().mockResolvedValue(undefined);
  apiMock.sshInstallKey.mockReset().mockResolvedValue({
    publicKey: "ssh-ed25519 AAAA tunnelde",
    keyPath: "C:\\data\\keys\\tunnelde_ed25519",
  });
  apiMock.hostsSnapshot
    .mockReset()
    .mockResolvedValue({ groups: [], hosts: [{ ...host, authMethod: "key" }] });
  useDialogs.setState({ confirm: vi.fn() });
  useHosts.setState({ hosts: [host] });
});

describe("ConnectDialog", () => {
  it("installs the public key with the typed password", async () => {
    render(<ConnectDialog host={host} onClose={() => undefined} />);

    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    fireEvent.change(password, { target: { value: "secret" } });

    const install = await screen.findByRole("button", { name: "Set up key login" });
    await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(install);

    await waitFor(() => {
      expect(apiMock.sshInstallKey).toHaveBeenCalledWith("host-1", "secret");
    });
    await waitFor(() => {
      expect(useHosts.getState().hosts[0]?.authMethod).toBe("key");
    });
  });

  it("hides the previous fingerprint when the key did not change", async () => {
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    await screen.findByText("SHA256:abc");
    expect(screen.queryByText(/Previous fingerprint/)).toBeNull();
  });

  it("offers a dedicated password-based key setup for an existing key host", async () => {
    const close = vi.fn();
    render(
      <ConnectDialog host={{ ...host, authMethod: "key" }} intent="installKey" onClose={close} />,
    );
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "setup-secret" },
    });
    const install = screen.getByRole("button", { name: "Set up key login" });
    await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(install);
    await waitFor(() =>
      expect(apiMock.sshInstallKey).toHaveBeenCalledWith("host-1", "setup-secret"),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("does not ask for a password for an unsupported agent record", async () => {
    render(<ConnectDialog host={{ ...host, authMethod: "agent" }} onClose={() => undefined} />);
    await screen.findByText("SHA256:abc");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByLabelText("Key passphrase")).toBeNull();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
