import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { FileRemoteDialog } from "@/features/sftp/FileRemoteDialog";
import type { Host, SshSession } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";

vi.mock("@/features/connect/ConnectDialog", () => ({
  ConnectDialog: () => <div>Connection prompt</div>,
}));

const host: Host = {
  id: "host",
  groupId: null,
  name: "Server",
  host: "new.example",
  port: 22,
  username: "alice",
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
const session: SshSession = {
  id: "session",
  hostId: "host",
  title: "Server",
  address: "alice@old.example:22",
  cols: 80,
  rows: 24,
  connectedAt: 0,
};

beforeEach(() => useHosts.setState({ hosts: [host] }));

describe("remote file connection selection", () => {
  it("opens a connection prompt when the saved address differs from the old connection", () => {
    useSsh.setState({ sessions: [session] });
    const connected = vi.fn();
    render(<FileRemoteDialog onClose={vi.fn()} onConnected={connected} />);
    expect(screen.queryByText("Connected")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Server/ }));
    expect(screen.getByText("Connection prompt")).toBeTruthy();
    expect(connected).not.toHaveBeenCalled();
  });

  it("reuses an existing session matching the current saved connection", () => {
    const current = { ...session, address: "alice@new.example:22" };
    useSsh.setState({ sessions: [session, current] });
    const connected = vi.fn();
    render(<FileRemoteDialog onClose={vi.fn()} onConnected={connected} />);
    expect(screen.getByText("Connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Server/ }));
    expect(connected).toHaveBeenCalledWith(current);
  });
});
