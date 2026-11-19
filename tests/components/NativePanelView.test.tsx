import "@/i18n/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NativePanelView } from "@/components/layout/NativePanelView";
import { usePanelWindows } from "@/store/panelWindows";
import { useWindowViews } from "@/lib/panels/windowViews";
import { createPanelViewState } from "@/lib/panels/viewState";
afterEach(() => {
  cleanup();
  usePanelWindows.setState({
    available: false,
    snapshot: { windows: [], panels: [], transfers: [] },
  });
  useWindowViews.setState({ entries: new Map() });
});
it("shows an explicit unknown-outcome safety boundary after coordinator loss instead of an idle retryable panel", () => {
  usePanelWindows.setState({
    available: true,
    snapshot: {
      windows: [],
      panels: [],
      transfers: [],
      interruptions: [{ panelId: "tasks", count: 1 }],
    },
  });
  useWindowViews.setState({
    entries: new Map([
      [
        "tasks",
        { key: "tasks:1", panelId: "tasks", controller: createPanelViewState(), staged: false },
      ],
    ]),
  });
  const view = render(
    <NativePanelView panelId="tasks">
      <button>Retry task</button>
    </NativePanelView>,
  );
  expect(screen.getByRole("alert").textContent).toContain("outcome is unknown");
  expect(view.container.querySelector(".native-panel-view")?.hasAttribute("inert")).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("restarting Tunnelde");
});
