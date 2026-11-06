import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
import "@/i18n/i18n";
import { ForwardingPanel } from "@/features/forwarding/ForwardingPanel";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { useWorkspace } from "@/store/workspace";
import type { Host } from "@/lib/api/types";

beforeEach(() => {
  useDialogs.getState().close();
  useNavigation.setState({ forwardingTarget: null });
  useHosts.setState({
    hosts: [
      { id: "one", name: "Server one" },
      { id: "two", name: "Server two" },
    ] as Host[],
  });
  useSsh.setState({ sessions: [] });
  const base = {
    name: "Forward",
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 8080,
    targetHost: "localhost",
    targetPort: 80,
    sessionId: null,
  };
  invokeMock.mockReset().mockResolvedValue([
    { ...base, id: "a", hostId: "one", active: true },
    { ...base, id: "b", hostId: "one", active: false },
    { ...base, id: "c", hostId: "two", active: true },
  ]);
});
it("offers host creation from the empty forwarding panel", async () => {
  useHosts.setState({ hosts: [], loaded: true, loading: false });
  render(<ForwardingPanel />);
  await act(async () => {});
  expect(screen.getByText("No hosts").closest(".td-empty")).toBeTruthy();
  expect(screen.getByText("Add a host to configure and manage port forwarding.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New host" }));
  expect(useDialogs.getState().dialog).toMatchObject({ kind: "host", host: null });
});
it("opens the existing panel for the originating host and SSH session", async () => {
  useSsh.setState({
    sessions: ["other", "current"].map((id) => ({
      id,
      hostId: "two",
      title: id,
      address: "server:22",
      cols: 80,
      rows: 24,
      connectedAt: 0,
    })),
  });
  render(<ForwardingPanel />);
  await act(async () => {
    useNavigation.getState().showForwarding("two", "current");
  });
  expect(screen.getByRole("button", { name: /Server two/ }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(screen.queryByRole("button", { name: "SSH session" })).toBeNull();
  expect(useNavigation.getState().activeSidebar).toBe("forwarding");
  act(() =>
    useWorkspace
      .getState()
      .splitTab("sidebar:forwarding", "row", "after", useWorkspace.getState().activePaneId),
  );
  act(() => useWorkspace.getState().toggleDockedSidebar("forwarding"));
  expect(useWorkspace.getState().tabs.find((tab) => tab.id === "sidebar:forwarding")?.hidden).toBe(
    true,
  );
  await act(async () => {
    useNavigation.getState().showForwarding("two", "other");
  });
  expect(
    useWorkspace.getState().tabs.find((tab) => tab.id === "sidebar:forwarding")?.hidden,
  ).not.toBe(true);
  expect(screen.queryByRole("button", { name: "SSH session" })).toBeNull();
});
it("shows forwarding status across hosts and opens one host manager without creating a terminal", async () => {
  render(<ForwardingPanel />);
  const first = await screen.findByRole("button", { name: /Server one/ });
  expect(screen.getByRole("button", { name: /Server two/ })).toBeTruthy();
  expect(first.textContent).not.toContain("Running");
  expect(invokeMock.mock.calls.filter(([command]) => command === "forwarding_list")).toHaveLength(
    1,
  );
  expect(first.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(first);
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(
    await within(first.parentElement!).findByRole("button", { name: "Add forward" }),
  ).toBeTruthy();
});
