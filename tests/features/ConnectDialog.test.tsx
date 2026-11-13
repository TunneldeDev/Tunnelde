import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  apiMock: {
    connectionRoute: vi.fn(),
    saveConnectionRoute: vi.fn(),
    sshProbe: vi.fn(),
    sshTestConnection: vi.fn(),
    sshCancelTest: vi.fn(),
    sshTrust: vi.fn(),
    credentialStatus: vi.fn(),
    credentialSave: vi.fn(),
    credentialForget: vi.fn(),
    sshInstallKey: vi.fn(),
    hostsSnapshot: vi.fn(),
  },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import "@/i18n/i18n";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";

const connect = vi.fn();

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

it("uses pinned native key verification without probing, trusting or testing an unbound destination", async () => {
  const verification = {
    probe: vi
      .fn()
      .mockResolvedValue({ hostId: host.id, fingerprint: "SHA256:pinned", status: "unknown" }),
    trust: vi
      .fn()
      .mockResolvedValue({ hostId: host.id, fingerprint: "SHA256:pinned", status: "known" }),
  };
  render(
    <ConnectDialog
      host={host}
      after="background"
      verification={verification}
      connectSession={vi.fn()}
      onClose={() => {}}
    />,
  );
  await screen.findByText("SHA256:pinned");
  fireEvent.click(screen.getByRole("button", { name: "Trust and continue" }));
  await waitFor(() =>
    expect(verification.trust).toHaveBeenCalledWith("SHA256:pinned", {}, host.id),
  );
  expect(apiMock.sshProbe).not.toHaveBeenCalled();
  expect(apiMock.sshTrust).not.toHaveBeenCalled();
  expect(invokeMock).not.toHaveBeenCalled();
  expect(screen.queryByText("Connection quality")).toBeNull();
  expect(screen.queryByRole("switch", { name: /remember/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Set up key login" })).toBeNull();
});

it("uses an exclusive requester and reports acceptance errors without leaving the dialog busy", async () => {
  const request = vi.fn().mockResolvedValue({ id: "exclusive", hostId: host.id });
  const accepted = vi.fn().mockRejectedValueOnce(Error("provider revoked"));
  const close = vi.fn();
  render(
    <ConnectDialog
      host={host}
      after="background"
      purpose="forwarding"
      connectSession={request}
      onConnected={accepted}
      onClose={close}
    />,
  );
  fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "test-only" } });
  await waitFor(() =>
    expect((screen.getByRole("button", { name: /^Connect$/ }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
  await screen.findByText("provider revoked");
  expect(connect).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ background: true, purpose: "forwarding" }),
    expect.objectContaining({ hostId: host.id, revision: expect.any(String) }),
  );
  accepted.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: /^Connect$/ }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

beforeEach(() => {
  // Native wire fixtures retain the existing dialog scenarios while the real
  // review adapter and its revision propagation execute unchanged.
  invokeMock.mockReset().mockImplementation(async (command, args) => {
    const { review, credentials } = args;
    switch (command) {
      case "connection_review_prepare": {
        const route = await apiMock.connectionRoute(args.displayed.id);
        return {
          review: { hostId: args.displayed.id, revision: "native-review" },
          jumpHosts: route.jumpHosts.map((id: string) =>
            useHosts.getState().hosts.find((host) => host.id === id),
          ),
        };
      }
      case "connection_review_probe":
        return apiMock.sshProbe(
          review.hostId,
          Object.keys(credentials).length ? credentials : undefined,
        );
      case "connection_review_trust":
        return {
          info: await apiMock.sshTrust(
            review.hostId,
            args.fingerprint,
            credentials,
            args.expectedHostId,
          ),
          review: { ...review, revision: review.revision + ":approved" },
        };
      case "connection_review_test":
        return apiMock.sshTestConnection(args.id, review.hostId, credentials);
      case "connection_review_install_key":
        return apiMock.sshInstallKey(review.hostId, args.password, credentials);
      case "connection_review_credential":
        return args.password === null
          ? apiMock.credentialForget(args.hostId)
          : apiMock.credentialSave(args.hostId, args.password);
      default:
        throw new Error(`Unmocked command: ${command}`);
    }
  });
  connect.mockReset().mockResolvedValue(null);
  useSsh.setState({ connect });
  apiMock.sshTrust.mockReset().mockResolvedValue({
    fingerprint: "SHA256:abc",
    algorithm: "ssh-ed25519",
    status: "known",
    knownFingerprint: "SHA256:abc",
  });
  apiMock.sshProbe.mockReset().mockResolvedValue({
    fingerprint: "SHA256:abc",
    algorithm: "ssh-ed25519",
    status: "known",
    knownFingerprint: "SHA256:abc",
  });
  apiMock.connectionRoute.mockReset().mockResolvedValue({ proxy: "", jumpHosts: [] });
  apiMock.sshTestConnection.mockReset();
  apiMock.sshCancelTest.mockReset().mockResolvedValue(undefined);
  apiMock.saveConnectionRoute.mockReset().mockResolvedValue(undefined);
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
  it("invalidates trust and clears typed credentials after a reviewed target changes", async () => {
    connect.mockImplementationOnce(async (_request, onError) => {
      onError({ code: "ssh", message: "ssh.connectionChanged" });
      return null;
    });
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    await screen.findByText("Trusted");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-target-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Close and reopen this dialog/);
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Password") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("Trusted")).toBeNull();
    expect(screen.queryByText("SHA256:abc")).toBeNull();
    expect(screen.queryByText(/Trust the key to continue/)).toBeNull();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      invokeMock.mock.calls.filter(([name]) => name === "connection_review_prepare"),
    ).toHaveLength(1);
  });
  it("connects discovered hosts with user credentials and never offers implicit vault persistence", async () => {
    const discovered: Host = {
      ...host,
      id: "source:digest",
      source: {
        pluginId: "inventory",
        pluginName: "Inventory",
        id: "cloud",
        label: "Cloud",
        entryId: "one",
      },
    };
    connect.mockResolvedValue({ id: "connection", hostId: discovered.id, terminal: true });
    const close = vi.fn();
    render(<ConnectDialog host={discovered} onClose={close} />);
    await screen.findByText("Trusted");
    expect(apiMock.credentialStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch", { name: /remember/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /install key/i })).toBeNull();
    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "user-entered-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: discovered.id, password: "user-entered-secret" }),
      expect.any(Function),
      expect.objectContaining({ key: expect.any(String), connect: expect.any(Function) }),
    );
    expect(apiMock.credentialSave).not.toHaveBeenCalled();
    expect(apiMock.sshInstallKey).not.toHaveBeenCalled();
  });
  it("connects forwarding in the background without opening a terminal or file tab", async () => {
    apiMock.credentialStatus.mockResolvedValue(true);
    connect.mockResolvedValue({ id: "background", hostId: host.id, terminal: false });
    const openTerminal = vi.spyOn(useWorkspace.getState(), "openTerminal");
    const openSftp = vi.spyOn(useWorkspace.getState(), "openSftp");
    const close = vi.fn();
    render(<ConnectDialog host={host} after="background" onClose={close} />);
    await screen.findByText("Trusted");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: host.id, background: true }),
      expect.any(Function),
      expect.objectContaining({ key: expect.any(String), connect: expect.any(Function) }),
    );
    expect(openTerminal).not.toHaveBeenCalled();
    expect(openSftp).not.toHaveBeenCalled();
    openTerminal.mockRestore();
    openSftp.mockRestore();
  });
  it("disables connecting during a quality test and cancels it when closed", async () => {
    apiMock.credentialStatus.mockResolvedValue(true);
    apiMock.sshTestConnection.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<ConnectDialog host={host} onClose={() => undefined} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(connect).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMock.sshTestConnection).toHaveBeenCalledOnce());
    unmount();
    expect(apiMock.sshCancelTest).toHaveBeenCalledExactlyOnceWith(
      apiMock.sshTestConnection.mock.calls[0]![0],
    );
  });

  it("discards a previous host's trust and password immediately when the target changes", async () => {
    const { rerender } = render(<ConnectDialog host={host} onClose={() => undefined} />);
    await screen.findByText("Trusted");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-secret" } });
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    apiMock.sshProbe.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () =>
      rerender(<ConnectDialog host={{ ...host, id: "other" }} onClose={() => undefined} />),
    );
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText("Trusted")).toBeNull();
  });

  it("requires explicit approval of an unknown key even when a password is saved", async () => {
    apiMock.sshProbe.mockResolvedValue({
      fingerprint: "SHA256:abc",
      algorithm: "ssh-ed25519",
      status: "unknown",
    });
    apiMock.credentialStatus.mockResolvedValue(true);
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    const trust = await screen.findByRole("button", { name: "Trust and continue" });
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(trust);
    await waitFor(() =>
      expect(apiMock.sshTrust).toHaveBeenCalledExactlyOnceWith("host-1", "SHA256:abc", {}, host.id),
    );
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  });

  it("refreshes the displayed key and refuses connection if it changes during approval", async () => {
    apiMock.sshProbe
      .mockResolvedValueOnce({
        fingerprint: "SHA256:abc",
        algorithm: "ssh-ed25519",
        status: "unknown",
      })
      .mockResolvedValue({
        fingerprint: "SHA256:new",
        algorithm: "ssh-ed25519",
        status: "unknown",
      });
    apiMock.sshTrust.mockRejectedValue({ code: "ssh", message: "ssh.hostKeyChanged" });
    apiMock.credentialStatus.mockResolvedValue(true);
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trust and continue" }));
    await screen.findByText("SHA256:new");
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(connect).not.toHaveBeenCalled();
    expect(apiMock.sshTrust).toHaveBeenCalledExactlyOnceWith("host-1", "SHA256:abc", {}, host.id);
  });

  it("waits for a password after approving a key when no credential is saved", async () => {
    apiMock.sshProbe.mockResolvedValue({
      fingerprint: "SHA256:abc",
      algorithm: "ssh-ed25519",
      status: "unknown",
    });
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trust and continue" }));
    await screen.findByText("Trusted");
    expect(connect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.keyDown(screen.getByLabelText("Password"), { key: "Enter" });
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({ password: "secret", hostId: "host-1" }),
        expect.any(Function),
        expect.objectContaining({ key: expect.any(String), connect: expect.any(Function) }),
      ),
    );
  });
  it("installs the public key with the typed password", async () => {
    render(<ConnectDialog host={host} onClose={() => undefined} />);

    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    fireEvent.change(password, { target: { value: "secret" } });

    const install = await screen.findByRole("button", { name: "Set up key login" });
    await waitFor(() => expect((install as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(install);

    await waitFor(() => {
      expect(apiMock.sshInstallKey).toHaveBeenCalledWith("host-1", "secret", {});
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
      expect(apiMock.sshInstallKey).toHaveBeenCalledWith("host-1", "setup-secret", {}),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("trusts each jump separately and never connects before the target key is approved", async () => {
    const jump = { ...host, id: "jump-1", name: "Bastion" };
    useHosts.setState({ hosts: [jump, host] });
    apiMock.connectionRoute.mockResolvedValue({ proxy: "", jumpHosts: [jump.id] });
    apiMock.credentialStatus.mockResolvedValue(true);
    apiMock.sshProbe
      .mockResolvedValueOnce({
        hostId: jump.id,
        fingerprint: "SHA256:jump",
        algorithm: "ssh-ed25519",
        status: "unknown",
      })
      .mockResolvedValueOnce({
        hostId: host.id,
        fingerprint: "SHA256:target",
        algorithm: "ssh-ed25519",
        status: "unknown",
      });
    apiMock.sshTrust
      .mockResolvedValueOnce({
        hostId: jump.id,
        fingerprint: "SHA256:jump",
        algorithm: "ssh-ed25519",
        status: "known",
      })
      .mockResolvedValueOnce({
        hostId: host.id,
        fingerprint: "SHA256:target",
        algorithm: "ssh-ed25519",
        status: "known",
      });
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    await screen.findByText("Host key: Bastion");
    fireEvent.click(screen.getByRole("button", { name: "Trust and continue" }));
    await screen.findByText("SHA256:target");
    expect(connect).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Trust and continue" }));
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(apiMock.sshTrust).toHaveBeenNthCalledWith(1, host.id, "SHA256:jump", {}, jump.id);
    expect(apiMock.sshTrust).toHaveBeenNthCalledWith(2, host.id, "SHA256:target", {}, host.id);
  });

  it("keeps the target untrusted when a jump needs a password and lets the user retry", async () => {
    const jump = { ...host, id: "jump-1", name: "Bastion" };
    useHosts.setState({ hosts: [jump, host] });
    apiMock.connectionRoute.mockResolvedValue({ proxy: "", jumpHosts: [jump.id] });
    apiMock.sshProbe
      .mockRejectedValueOnce({ code: "ssh", message: "ssh.passwordRequired" })
      .mockResolvedValueOnce({
        hostId: host.id,
        fingerprint: "SHA256:target",
        algorithm: "ssh-ed25519",
        status: "unknown",
      });
    render(<ConnectDialog host={host} onClose={() => undefined} />);
    const input = await screen.findByLabelText("Bastion · Password");
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "jump-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify connection route" }));
    await screen.findByText("SHA256:target");
    expect(apiMock.sshProbe).toHaveBeenLastCalledWith(host.id, {
      "jump-1": { password: "jump-secret" },
    });
    expect(connect).not.toHaveBeenCalled();
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
