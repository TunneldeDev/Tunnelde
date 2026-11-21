import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ForwardingPanelView } from "@/features/forwarding/components/ForwardingPanelView";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import type { ForwardingPanelViewProps } from "@/features/forwarding/components/ForwardingPanelView";
import type { ForwardInfo } from "@/features/forwarding/model/contract";
const denied = vi.hoisted(() => {
  const read = vi.fn(() => {
    throw new Error("main store must not be read");
  });
  return { read, store: Object.assign(read, { getState: read, subscribe: read }) };
});
vi.mock("@/store/hosts", () => ({ useHosts: denied.store }));
vi.mock("@/store/navigation", () => ({ useNavigation: denied.store }));
vi.mock("@/store/dialogs", () => ({ useDialogs: denied.store }));
vi.mock("@/store/ssh", () => ({ useSsh: denied.store }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: denied.read }));
// Layout chrome has its own native adapter tests. Here every feature route
// must come exclusively from the explicit display model and owner renderers.
vi.mock("@/components/layout/WorkbenchPanel", () => ({
  PanelHeader: () => <header>Forwarding</header>,
}));
afterEach(() => {
  cleanup();
  expect(denied.read).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
const hosts = [
  { id: "one", name: "Server one" },
  { id: "two", name: "Server two" },
];
function fixture(overrides: Partial<ForwardingPanelViewProps<(typeof hosts)[number]>> = {}) {
  const renderHost = vi.fn((host: (typeof hosts)[number]) => (
    <section aria-label={`${host.name} manager`}>{host.id}</section>
  ));
  const props = {
    hosts,
    hostsLoading: false,
    sessions: [],
    rules: [],
    error: null,
    renderHost,
    ...overrides,
  };
  return { props, renderHost };
}
function rule(id: string, active: boolean, sessionId: string | null, hostId = "one"): ForwardInfo {
  return {
    id,
    active,
    sessionId,
    hostId,
    revision: id,
    name: id,
    mode: "local",
    bindHost: "127.0.0.1",
    bindPort: 8080,
    targetHost: "localhost",
    targetPort: 80,
  };
}
it("renders only the explicitly expanded host and supplies the original display identity", () => {
  const { props, renderHost } = fixture();
  render(<ForwardingPanelView {...props} />);
  expect(renderHost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Server one" }));
  expect(screen.getByRole("region", { name: "Server one manager" })).toBeTruthy();
  expect(renderHost).toHaveBeenLastCalledWith(hosts[0]);
  fireEvent.click(screen.getByRole("button", { name: "Server two" }));
  expect(screen.queryByRole("region", { name: "Server one manager" })).toBeNull();
  expect(renderHost).toHaveBeenLastCalledWith(hosts[1]);
  fireEvent.click(screen.getByRole("button", { name: "Server two" }));
  expect(screen.queryByRole("region")).toBeNull();
});
it("counts only active rules with a live session in the supplied display frame", () => {
  const { props } = fixture({
    rules: [
      rule("live", true, "ssh"),
      rule("stale", true, "gone"),
      rule("stopped", false, "ssh"),
      rule("foreign", true, "ssh", "missing"),
    ],
    sessions: [{ id: "ssh", hostId: "one", purpose: "forwarding" }],
  });
  const view = render(<ForwardingPanelView {...props} />);
  expect(screen.getByRole("button", { name: "Server one 1 Running" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Server two" })).toBeTruthy();
  view.rerender(<ForwardingPanelView {...props} sessions={[]} />);
  expect(screen.getByRole("button", { name: "Server one" })).toBeTruthy();
});
it("captures owner navigation and restores selection without the originating navigation store", async () => {
  const source = createPanelViewState();
  const { props } = fixture({ target: { hostId: "two", revision: 7 } });
  const view = render(
    <PanelViewStateScope controller={source}>
      <ForwardingPanelView {...props} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  expect(source.capture().fields["forwarding-selection"]).toEqual({
    hostId: "two",
    targetRevision: 7,
  });
  const capsule = source.capture();
  view.unmount();
  const destination = createPanelViewState(capsule);
  render(
    <PanelViewStateScope controller={destination}>
      <ForwardingPanelView {...props} target={null} />
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("region", { name: "Server two manager" })).toBeTruthy();
  expect(destination.capture()).toEqual(capsule);
});
it("does not replay consumed navigation after collapse; a new revision can reveal the same host", async () => {
  const { props } = fixture({ target: { hostId: "one", revision: 3 } });
  const view = render(<ForwardingPanelView {...props} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Server one" }));
  view.rerender(<ForwardingPanelView {...props} target={{ hostId: "one", revision: 3 }} />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(<ForwardingPanelView {...props} target={{ hostId: "one", revision: 4 }} />);
  expect(screen.getByRole("region", { name: "Server one manager" })).toBeTruthy();
});
it("keeps loading and unavailable host-creation routes explicit, with no fabricated main dialog", () => {
  const create = vi.fn();
  const { props } = fixture({ hosts: [], hostsLoading: true });
  const view = render(<ForwardingPanelView {...props} />);
  expect(screen.getByRole("status")).toHaveProperty("textContent", "Loading");
  view.rerender(<ForwardingPanelView {...props} hostsLoading={false} />);
  expect(screen.getByText("No hosts")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(
    <ForwardingPanelView
      {...props}
      hostsLoading={false}
      emptyAction={<button onClick={create}>Create in this window</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create in this window" }));
  expect(create).toHaveBeenCalledOnce();
});
it("shows owner-rendered errors as text and retires the host section when its display identity disappears", async () => {
  const { props } = fixture({
    target: { hostId: "one", revision: 1 },
    error: "<b>owner unavailable</b>",
  });
  const view = render(<ForwardingPanelView {...props} />);
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveProperty("textContent", "<b>owner unavailable</b>");
  expect(screen.getByRole("alert").querySelector("b")).toBeNull();
  view.rerender(<ForwardingPanelView {...props} hosts={[hosts[1]!]} />);
  expect(screen.queryByRole("region")).toBeNull();
});
