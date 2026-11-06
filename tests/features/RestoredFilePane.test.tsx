import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { RestoredFilePane } from "@/features/sftp/RestoredFilePane";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

const mock = vi.hoisted(() => ({
  session: { id: "new", hostId: "host", address: "user@example:22", title: "Server" },
}));
vi.mock("@/features/sftp/FileRemoteDialog", () => ({
  FileRemoteDialog: ({ onConnected }: { onConnected: (session: typeof mock.session) => void }) => (
    <button onClick={() => onConnected(mock.session)}>Choose connection</button>
  ),
}));

const tab: WorkspaceTab = {
  id: "files:restore",
  kind: "sftp",
  title: "Server",
  hostId: null,
  pinned: false,
  filePane: {
    source: { kind: "remote", sessionId: "" },
    ownerSessionId: "",
    path: "/project",
    offline: true,
    remoteIdentity: { hostId: "host", address: "user@example:22" },
  },
};

beforeEach(() => {
  mock.session = { id: "new", hostId: "host", address: "user@example:22", title: "Server" };
  useWorkspace.setState({ tabs: [tab] });
});

describe("restored remote file panel", () => {
  it("waits for user action and restores the path for the same host", () => {
    render(<RestoredFilePane tab={tab} />);
    expect(screen.queryByText("Choose connection")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Connect remote/i }));
    fireEvent.click(screen.getByText("Choose connection"));
    expect(useWorkspace.getState().tabs[0]?.filePane).toMatchObject({
      path: "/project",
      offline: false,
      source: { sessionId: "new" },
    });
  });

  it("does not carry a remote path to a different connection", () => {
    mock.session.address = "user@other:22";
    render(<RestoredFilePane tab={tab} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect remote/i }));
    fireEvent.click(screen.getByText("Choose connection"));
    expect(useWorkspace.getState().tabs[0]?.filePane?.path).toBeNull();
  });
});
