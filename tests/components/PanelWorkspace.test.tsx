import "@/i18n/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
