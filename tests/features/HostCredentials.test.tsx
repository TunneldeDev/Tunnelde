import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    connectionRoute: vi.fn(),
    saveConnectionRoute: vi.fn(),
    credentialStatus: vi.fn(),
    credentialSave: vi.fn(),
    credentialForget: vi.fn(),
  },
}));
vi.mock("@/lib/api/ipc", () => ({ api: apiMock }));

import i18n from "@/i18n/i18n";
import { DialogHost } from "@/features/dialogs/DialogHost";
import type { Host } from "@/lib/api/types";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

const host: Host = {
  id: "h1",
  name: "Web",
  host: "example.com",
  username: "user",
  port: 22,
  authMethod: "password",
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
const createHost = vi.fn();
const updateHost = vi.fn();

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  apiMock.connectionRoute.mockReset().mockResolvedValue({ proxy: "", jumpHosts: [] });
  apiMock.saveConnectionRoute.mockReset().mockResolvedValue(undefined);
  apiMock.credentialStatus.mockResolvedValue(true);
  apiMock.credentialSave.mockResolvedValue(undefined);
  apiMock.credentialForget.mockResolvedValue(undefined);
  createHost.mockResolvedValue(host);
  updateHost.mockResolvedValue(host);
  useHosts.setState({ groups: [], hosts: [host], createHost, updateHost });
  useWorkspace.setState({ renameHost: vi.fn(), openHost: vi.fn() });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useDialogs.setState({ dialog: { kind: "host", host } });
});

describe("host password editing", () => {
  it("keeps saved passwords hidden and preserves them when editing metadata", async () => {
    render(<DialogHost />);
    await screen.findByRole("button", { name: "Remove saved password" });
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useDialogs.getState().dialog.kind).toBe("none"));
    expect(apiMock.credentialSave).not.toHaveBeenCalled();
    expect(apiMock.credentialForget).not.toHaveBeenCalled();
    expect(updateHost).toHaveBeenCalledWith("h1", expect.objectContaining({ name: "Renamed" }));
  });

  it("saves the exact password to the vault without putting it into host data", async () => {
    render(<DialogHost />);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: " secret with spaces " },
    });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiMock.credentialSave).toHaveBeenCalledWith("h1", " secret with spaces "),
    );
    expect(updateHost.mock.calls[0]![1]).not.toHaveProperty("password");
  });

  it("stages password removal until Save and allows undo or cancel", async () => {
    render(<DialogHost />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved password" }));
    expect(apiMock.credentialForget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiMock.credentialForget).not.toHaveBeenCalled();
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("removes a saved password only when the draft is saved", async () => {
    render(<DialogHost />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved password" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.credentialForget).toHaveBeenCalledExactlyOnceWith("h1"));
  });

  it("retries vault failures without creating duplicate hosts or losing the password", async () => {
    useDialogs.setState({ dialog: { kind: "host", host: null } });
    apiMock.credentialSave.mockRejectedValueOnce(new Error("Vault unavailable"));
    render(<DialogHost />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Web" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Host details were saved.*Vault unavailable/);
    expect(useDialogs.getState().dialog.kind).toBe("host");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("secret");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useDialogs.getState().dialog.kind).toBe("none"));
    expect(createHost).toHaveBeenCalledOnce();
    expect(updateHost).toHaveBeenCalledOnce();
    expect(apiMock.credentialSave).toHaveBeenCalledTimes(2);
  });

  it("does not offer a password field for key authentication", async () => {
    useDialogs.setState({
      dialog: { kind: "host", host: { ...host, authMethod: "key", keyPath: "/key" } },
    });
    render(<DialogHost />);
    expect(screen.queryByLabelText("Password")).toBeNull();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useDialogs.getState().dialog.kind).toBe("none"));
    expect(apiMock.credentialSave).not.toHaveBeenCalled();
  });
});
