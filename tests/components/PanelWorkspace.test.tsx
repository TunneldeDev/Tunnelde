import "@/i18n/i18n";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useEffect, useState } from "react";
import { PanelWorkspace } from "@/components/layout/PanelWorkspace";
import { useLocalPanelScope } from "@/lib/panels/localWorkspaceScope";
import type { LocalPanelWorkspace } from "@/lib/panels/localWorkspace";
let workspace: LocalPanelWorkspace;
let mounts = 0,
  unmounts = 0;
function Content({ id }: { id: string }) {
  const scope = useLocalPanelScope()!;
  useEffect(() => {
    workspace = scope.workspace;
  }, [scope.workspace]);
  const [value, setValue] = useState("");
  useEffect(() => {
    mounts++;
    return () => {
      unmounts++;
    };
  }, []);
  return <input aria-label={id} value={value} onChange={(e) => setValue(e.target.value)} />;
}
afterEach(() => {
  cleanup();
  mounts = 0;
  unmounts = 0;
});
const entries = [
  { id: "tasks" as const, key: "tasks-1", content: <Content id="tasks" /> },
  { id: "connections" as const, key: "connections-1", content: <Content id="connections" /> },
];
it("retains one portal owner and DOM input across tabs, splits, floating and merging", async () => {
  const { act } = await import("@testing-library/react");
  render(<PanelWorkspace entries={entries} />);
  const input = screen.getByRole("textbox", { name: "connections" });
  fireEvent.change(input, { target: { value: "draft/secret" } });
  expect(mounts).toBe(2);
  await act(() => workspace.split("connections", "row"));
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  await act(() => workspace.float("connections"));
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("draft/secret");
  await act(() => workspace.dock("connections"));
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("draft/secret");
  expect(mounts).toBe(2);
  expect(unmounts).toBe(0);
});
it("supports tab keyboard navigation and retires only removed native memberships", () => {
  const view = render(<PanelWorkspace entries={entries} />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs[1]!, { key: "ArrowLeft" });
  expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[0]);
  view.rerender(<PanelWorkspace entries={entries.slice(1)} />);
  expect(screen.getByRole("textbox", { name: "connections" }).isConnected).toBe(true);
  expect(unmounts).toBe(1);
});

it("drags tabs to split edges, merges in the center and discards cancelled hover previews without remounting content", async () => {
  const { endLocalPanelDrag } = await import("@/lib/panels/localPanelDrag");
  const { act } = await import("@testing-library/react");
  const view = render(<PanelWorkspace entries={entries} />);
  const transfer = () => {
    const data = new Map<string, string>();
    return {
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? "",
    };
  };
  const point = (element: Element) =>
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 600,
        bottom: 400,
        width: 600,
        height: 400,
      }),
    });
  const send = (
    element: Element,
    kind: "dragOver" | "drop",
    dataTransfer: unknown,
    x: number,
    y: number,
  ) => {
    const event = createEvent[kind](element, { dataTransfer });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
    fireEvent(element, event);
  };
  const input = screen.getByRole("textbox", { name: "connections" });
  fireEvent.change(input, { target: { value: "keep draft" } });
  let body = view.container.querySelector(".panel-workspace__group-body")!;
  point(body);
  let dataTransfer = transfer();
  fireEvent.dragStart(view.container.querySelector('[data-local-tab="connections"]')!, {
    dataTransfer,
  });
  send(input, "dragOver", dataTransfer, 590, 200);
  expect(view.container.querySelector(".panel-workspace__drop.is-right")).toBeTruthy();
  expect(workspace.store.getState().groups).toHaveLength(1); // Hover has no effects.
  send(input, "drop", dataTransfer, 590, 200);
  expect(workspace.store.getState().groups).toHaveLength(2);
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  const target = [...view.container.querySelectorAll("[data-local-group]")].find((group) =>
    group.querySelector('[data-local-tab="tasks"]'),
  )!;
  body = target.querySelector(".panel-workspace__group-body")!;
  point(body);
  dataTransfer = transfer();
  fireEvent.dragStart(view.container.querySelector('[data-local-tab="connections"]')!, {
    dataTransfer,
  });
  send(body, "dragOver", dataTransfer, 300, 200);
  expect(view.container.querySelector(".panel-workspace__drop.is-merge")).toBeTruthy();
  await act(() => {
    endLocalPanelDrag();
    fireEvent.dragEnd(document.documentElement);
  });
  expect(view.container.querySelector(".panel-workspace__drop")).toBeNull();
  expect(workspace.store.getState().groups).toHaveLength(2);
  dataTransfer = transfer();
  fireEvent.dragStart(view.container.querySelector('[data-local-tab="connections"]')!, {
    dataTransfer,
  });
  send(body, "drop", dataTransfer, 300, 200);
  expect(workspace.store.getState().groups).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("keep draft");
  expect(mounts).toBe(2);
  expect(unmounts).toBe(0);
});

it("retains hidden portal trees, drafts and split slots through the source presentation adapter", async () => {
  const { act } = await import("@testing-library/react");
  const { sourcePanelPresentation } = await import("@/lib/panels/sourcePresentation");
  const view = render(<PanelWorkspace windowId="native-source" entries={entries} />);
  const host = sourcePanelPresentation()!;
  const input = screen.getByRole("textbox", { name: "connections" });
  fireEvent.change(input, { target: { value: "retained hidden draft" } });
  await act(() => workspace.split("connections", "row"));
  const layout = workspace.store.getState().layout;
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
  await act(() => host.close("connections"));
  expect(screen.queryByRole("textbox", { name: "connections" })).toBeNull();
  expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
  expect(host.read().find((p) => p.id === "connections")).toMatchObject({
    visible: false,
    presentation: "workspace",
    available: true,
    windowId: "native-source",
  });
  expect(unmounts).toBe(0);
  await act(() => host.reveal("connections"));
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("retained hidden draft");
  expect(workspace.store.getState().layout).toBe(layout);
  await act(() => {
    host.set("connections", "floating");
    host.close("connections");
    host.close("tasks");
  });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(unmounts).toBe(0);
  await act(() => host.reveal("connections"));
  expect(screen.getByRole("textbox", { name: "connections" })).toBe(input);
  expect(host.read().find((p) => p.id === "connections")).toMatchObject({
    visible: true,
    presentation: "floating",
  });
  view.unmount();
  expect(unmounts).toBe(2);
  expect(sourcePanelPresentation()).toBeNull();
});

it("accepts ordinary page IDs and explicit titles without treating them as sidebar views", () => {
  const view = render(
    <PanelWorkspace
      entries={[
        {
          id: "terminal:qa-session",
          title: "qa@localhost",
          key: "lease:7",
          content: <Content id="ordinary" />,
        },
      ]}
    />,
  );
  expect(screen.getByRole("tab", { name: /qa@localhost/ })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "ordinary" });
  view.rerender(
    <PanelWorkspace
      entries={[
        {
          id: "terminal:qa-session",
          title: "renamed host",
          key: "lease:7",
          content: <Content id="ordinary" />,
        },
      ]}
    />,
  );
  expect(screen.getByRole("tab", { name: /renamed host/ })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "ordinary" })).toBe(input);
  expect(mounts).toBe(1);
});
