import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    connectionRoute: vi.fn(),
    credentialStatus: vi.fn(),
    saveHostEditor: vi.fn(),
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
  apiMock.credentialStatus.mockResolvedValue(true);
  apiMock.saveHostEditor.mockResolvedValue({ host, credentialError: null });
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
    expect(apiMock.saveHostEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "h1",
        input: expect.objectContaining({ name: "Renamed" }),
        credential: { action: "keep" },
      }),
    );
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
      expect(apiMock.saveHostEditor).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "h1",
          credential: { action: "save", password: " secret with spaces " },
        }),
      ),
    );
    expect(apiMock.saveHostEditor.mock.calls[0]![0].input).not.toHaveProperty("password");
  });

  it("stages password removal until Save and allows undo or cancel", async () => {
    render(<DialogHost />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved password" }));
    expect(apiMock.saveHostEditor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiMock.saveHostEditor).not.toHaveBeenCalled();
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
    await waitFor(() =>
      expect(apiMock.saveHostEditor).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "h1", credential: { action: "forget" } }),
      ),
    );
  });

  it("retries vault failures without creating duplicate hosts or losing the password", async () => {
    useDialogs.setState({ dialog: { kind: "host", host: null } });
    apiMock.saveHostEditor.mockResolvedValueOnce({
      host,
      credentialError: new Error("Vault unavailable"),
    });
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
    expect(apiMock.saveHostEditor).toHaveBeenCalledTimes(2);
    expect(apiMock.saveHostEditor.mock.calls[0]![0].id).toBeNull();
    expect(apiMock.saveHostEditor.mock.calls[1]![0].id).toBe("h1");
    expect(useHosts.getState().hosts.filter((item) => item.id === "h1")).toHaveLength(1);
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
    expect(apiMock.saveHostEditor).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { action: "keep" } }),
    );
  });

  it("keeps an unsaved draft and reports the original error when field persistence fails", async () => {
    useDialogs.setState({ dialog: { kind: "host", host: null } });
    apiMock.saveHostEditor.mockRejectedValueOnce(new Error("Route no longer exists"));
    render(<DialogHost />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Route no longer exists");
    expect(screen.queryByText(/Host details were saved/)).toBeNull();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("secret");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useDialogs.getState().dialog.kind).toBe("none"));
    expect(apiMock.saveHostEditor.mock.calls[1]![0].id).toBeNull();
  });
});
