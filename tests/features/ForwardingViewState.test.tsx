import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));
import "@/i18n/i18n";
import { ForwardingPanel } from "@/features/forwarding/ForwardingPanel";
import { ForwardingSection } from "@/features/forwarding/ForwardingSection";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useNavigation } from "@/store/navigation";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { Host } from "@/lib/api/types";
const host = {
  id: "one",
  name: "Server one",
  host: "one.invalid",
  port: 22,
  username: "me",
} as Host;
beforeEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  useNavigation.setState({ forwardingTarget: null });
  useHosts.setState({ hosts: [host], loaded: true, loading: false });
  useSsh.setState({ sessions: [] });
  invoke.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
});

it("captures external host selection and incomplete rule fields without saving or reconnecting", async () => {
  const persisted = vi.spyOn(Storage.prototype, "setItem");
  const source = createPanelViewState();
  const view = render(
    <PanelViewStateScope controller={source}>
      <ForwardingPanel />
    </PanelViewStateScope>,
  );
  await act(async () => {
    useNavigation.getState().showForwarding(host.id, "origin-session");
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add forward" }));
  const ports = screen.getAllByRole("spinbutton");
  fireEvent.change(ports[0]!, { target: { value: "" } });
  fireEvent.change(ports[1]!, { target: { value: "4321" } });
  const texts = screen.getAllByRole("textbox");
  fireEvent.change(texts[0]!, { target: { value: "127.0.0.2" } });
  const capsule = source.capture();
  expect(capsule.fields["forwarding-selection"]).toMatchObject({ hostId: host.id });
  view.unmount();
  useNavigation.setState({ forwardingTarget: null });
  const destination = createPanelViewState(capsule);
  render(
    <PanelViewStateScope controller={destination}>
      <ForwardingPanel />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  expect(screen.getByRole("button", { name: /Server one/ }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(screen.getAllByRole("spinbutton")[0]).toHaveProperty("value", "");
  expect(screen.getAllByRole("spinbutton")[1]).toHaveProperty("value", "4321");
  expect(screen.getAllByRole("textbox")[0]).toHaveProperty("value", "127.0.0.2");
  expect(destination.capture()).toEqual(capsule);
  expect(
    invoke.mock.calls.every(([name]) =>
      ["forwarding_list", "forwarding_groups_list"].includes(name),
    ),
  ).toBe(true);
  expect(persisted).not.toHaveBeenCalled();
  persisted.mockRestore();
});

it("restores a new group dialog's draft and discards it after explicit cancellation", async () => {
  const source = createPanelViewState();
  const view = render(
    <PanelViewStateScope controller={source}>
      <ForwardingSection host={host} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Pending database tunnels" },
  });
  const capsule = source.capture();
  expect(JSON.stringify(capsule)).not.toContain("undefined");
  view.unmount();
  const destination = createPanelViewState(capsule);
  render(
    <PanelViewStateScope controller={destination}>
      <ForwardingSection host={host} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  expect(screen.getByRole("textbox", { name: "Group name" })).toHaveProperty(
    "value",
    "Pending database tunnels",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  expect(screen.getByRole("textbox", { name: "Group name" })).toHaveProperty("value", "");
});

it("does not restore another host's rule or group draft into the destination host", async () => {
  const source = createPanelViewState();
  const view = render(
    <PanelViewStateScope controller={source}>
      <ForwardingSection host={host} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "one-only" } });
  const capsule = source.capture();
  view.unmount();
  render(
    <PanelViewStateScope controller={createPanelViewState(capsule)}>
      <ForwardingSection host={{ ...host, id: "two" }} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  expect(screen.queryByRole("form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add forward" }));
  expect(screen.getAllByRole("textbox")[0]).toHaveProperty("value", "127.0.0.1");
});

it("rejects group work in flight rather than replaying its save in a destination", async () => {
  let finish!: () => void;
  const saved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  invoke.mockImplementation((command) =>
    command === "forwarding_group_save" ? saved : Promise.resolve([]),
  );
  const state = createPanelViewState();
  render(
    <PanelViewStateScope controller={state}>
      <ForwardingSection host={host} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Group" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(() => state.capture()).toThrow("panels.finishInteractionBeforeMoving");
  await expect(state.captureAsync()).rejects.toThrow("panels.finishInteractionBeforeMoving");
  await act(async () => {
    finish();
    await saved;
  });
  expect(() => state.capture()).not.toThrow();
  expect(invoke.mock.calls.filter(([command]) => command === "forwarding_group_save")).toHaveLength(
    1,
  );
});

it("does not revive another host's new group dialog or its name", async () => {
  const source = createPanelViewState();
  const view = render(
    <PanelViewStateScope controller={source}>
      <ForwardingSection host={host} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "one-only group" },
  });
  const capsule = source.capture();
  view.unmount();
  render(
    <PanelViewStateScope controller={createPanelViewState(capsule)}>
      <ForwardingSection host={{ ...host, id: "two" }} />
    </PanelViewStateScope>,
  );
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New forwarding group" }));
  expect(screen.getByRole("textbox", { name: "Group name" })).toHaveProperty("value", "");
});
