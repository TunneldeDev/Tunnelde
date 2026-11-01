import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { DialogHost } from "@/features/dialogs/DialogHost";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

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
  color: "#123456",
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
};
const updateHost = vi.fn(async () => host);
const createHost = vi.fn(async () => host);

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useHosts.setState({ groups: [], hosts: [host], updateHost, createHost });
  useWorkspace.setState({ renameHost: vi.fn(), openHost: vi.fn() });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useDialogs.setState({ dialog: { kind: "host", host } });
});

describe("host color editing", () => {
  it("preserves an existing host color when saving other host fields", async () => {
    render(<DialogHost />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Web renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateHost).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ name: "Web renamed", color: "#123456" }),
      ),
    );
  });

  it("keeps picker changes in the host draft, applies on Save and allows removing the color", async () => {
    render(<DialogHost />);
    fireEvent.click(screen.getByRole("button", { name: "Host color" }));
    fireEvent.change(screen.getByRole("textbox", { name: "HEX" }), {
      target: { value: "#abcdef" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(updateHost).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Host color" }).textContent).toContain("#ABCDEF");
    fireEvent.click(screen.getByRole("button", { name: "Remove host color" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateHost).toHaveBeenCalledWith("h1", expect.objectContaining({ color: null })),
    );
  });

  it("keeps host dialog open and its color unchanged when cancelling the nested picker", () => {
    render(<DialogHost />);
    fireEvent.click(screen.getByRole("button", { name: "Host color" }));
    const picker = screen.getByRole("dialog", { name: "Host color" });
    fireEvent.change(within(picker).getByRole("textbox", { name: "HEX" }), {
      target: { value: "#abcdef" },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Host color" }).textContent).toContain("#123456");
    expect(useDialogs.getState().dialog.kind).toBe("host");
    expect(updateHost).not.toHaveBeenCalled();
  });

  it("stores a newly chosen color when creating a host", async () => {
    useDialogs.setState({ dialog: { kind: "host", host: null } });
    render(<DialogHost />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New server" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "192.168.0.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Host color" }));
    fireEvent.change(screen.getByRole("textbox", { name: "HEX" }), {
      target: { value: "#abcdef" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(createHost).toHaveBeenCalledWith(
        expect.objectContaining({ name: "New server", color: "#abcdef" }),
      ),
    );
  });

  it("uses the current accent as the default and lets picker Reset remove the host override", async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, accent: "#2468ac" } });
    render(<DialogHost />);
    fireEvent.click(screen.getByRole("button", { name: "Host color" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset color" }));
    expect((screen.getByRole("textbox", { name: "HEX" }) as HTMLInputElement).value).toBe(
      "#2468ac",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(updateHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateHost).toHaveBeenCalledWith("h1", expect.objectContaining({ color: null })),
    );
  });
});
