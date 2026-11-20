import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionDetails } from "@/components/layout/ConnectionStatus";
import { ConnectionModelScope } from "@/lib/panels/connectionModel";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { DockedBackgroundTasks } from "@/features/tasks/BackgroundTasks";
import { TaskModelScope, type TaskPanelModel } from "@/lib/panels/taskModel";
import type { SshSession } from "@/lib/api/types";
afterEach(cleanup);
it("captures and restores hundreds of actual session disclosures and confirmations without exhausting root fields", async () => {
  const sessions: SshSession[] = Array.from({ length: 180 }, (_, i) => ({
    id: `session-${i}`,
    hostId: "h",
    title: `Session ${i}`,
    address: `qa-${i}.invalid`,
    cols: 80,
    rows: 24,
    connectedAt: 0,
  }));
  const content = (controller: ReturnType<typeof createPanelViewState>) => (
    <PanelViewStateScope controller={controller}>
      <ConnectionModelScope
        model={{ version: 1, sessions, hosts: [], history: [], disconnectingSessionIds: [] }}
        disconnect={vi.fn()}
        disconnectMany={vi.fn()}
      >
        <ConnectionDetails />
      </ConnectionModelScope>
    </PanelViewStateScope>
  );
  const source = createPanelViewState();
  const view = render(content(source));
  const last = view.container.querySelectorAll<HTMLDetailsElement>("details")[179]!;
  await act(() => {
    last.open = true;
    last.dispatchEvent(new Event("toggle"));
  });
  fireEvent.click(
    view.container.querySelectorAll<HTMLButtonElement>(".connection-list__heading button")[179]!,
  );
  const snapshot = source.capture();
  expect(Object.keys(snapshot.fields).sort()).toEqual([
    "connections.confirming",
    "connections.query",
    "connections.rows",
    "connections.selection",
  ]);
  view.unmount();
  const restored = render(content(createPanelViewState(snapshot)));
  expect(restored.container.querySelectorAll<HTMLDetailsElement>("details")[179]!.open).toBe(true);
  expect(restored.container.querySelectorAll(".connection-list__confirm")).toHaveLength(1);
});
it("keeps paginated task errors and page size when more than 256 rows are displayed", async () => {
  const model: TaskPanelModel = {
    items: Array.from({ length: 270 }, (_, i) => ({
      id: `task-${i}`,
      key: `task-${i}`,
      source: "qa",
      title: `Task ${i}`,
      status: "running",
      execution: "native",
      updatedAt: 0,
      actions: [{ id: "pause", label: `Pause ${i}`, run: () => {} }],
    })),
    viewKey: (task) => task.id,
    run: vi.fn().mockRejectedValue(new Error("explicit action failure")),
    clear: vi.fn(),
  };
  const content = (controller: ReturnType<typeof createPanelViewState>) => (
    <PanelViewStateScope controller={controller}>
      <TaskModelScope value={model}>
        <DockedBackgroundTasks />
      </TaskModelScope>
    </PanelViewStateScope>
  );
  const source = createPanelViewState();
  const view = render(content(source));
  for (let i = 0; i < 13; i++)
    fireEvent.click(view.container.querySelector<HTMLButtonElement>(".background-group__more")!);
  expect(view.container.querySelectorAll(".background-task")).toHaveLength(270);
  fireEvent.click(screen.getByRole("button", { name: "Pause 269" }));
  await waitFor(() => expect(screen.getByText("explicit action failure")).toBeTruthy());
  const snapshot = source.capture();
  expect(Object.keys(snapshot.fields)).toEqual(["tasks.rows"]);
  view.unmount();
  const restored = render(content(createPanelViewState(snapshot)));
  expect(restored.container.querySelectorAll(".background-task")).toHaveLength(270);
  expect(screen.getByText("explicit action failure")).toBeTruthy();
});
