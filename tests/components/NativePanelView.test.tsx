import "@/i18n/i18n";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
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
it("renders nothing in a source window after its panel has moved elsewhere", () => {
  usePanelWindows.setState({
    available: true,
    snapshot: {
      windows: [],
      panels: [{ panelId: "tasks", windowId: "target", generation: 2 }],
      transfers: [],
    },
  });
  const view = render(
    <NativePanelView panelId="tasks">
      <button>stale panel body</button>
    </NativePanelView>,
  );
  expect(view.container.textContent).toBe("");
  expect(screen.queryByRole("button", { name: "stale panel body" })).toBeNull();
  expect(screen.queryByText(/another window|另一个窗体/)).toBeNull();
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

it.each(["tasks", "forwarding"])(
  "does not restore %s focus into a loading shell; readiness and commit both gate focus",
  async (panelId) => {
    const { act } = await import("@testing-library/react");
    const { createWindowViews, installWindowViews } = await import("@/lib/panels/windowViews");
    const { usePanelViewController } = await import("@/lib/panels/viewState");
    const { useLayoutEffect, useState } = await import("react");
    const { vi } = await import("vitest");
    const lease = { panelId, windowId: "source", generation: 1 };
    const offer = { id: "async-focus", lease, targetWindow: "target" };
    const client = {
      windowId: "target",
      control: vi.fn(),
    } as unknown as PanelWindowClient;
    const views = createWindowViews(client),
      uninstall = installWindowViews(views);
    let ready!: () => void, show!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    function Renderer() {
      const controller = usePanelViewController();
      const [loaded, set] = useState(false);
      show = () => set(true);
      useLayoutEffect(
        () =>
          controller?.registerAsync(
            "factory",
            async () => null,
            () => gate,
          ),
        [controller],
      );
      return loaded ? (
        <input aria-label="restored draft" data-panel-focus="draft" defaultValue="abcdef" />
      ) : (
        <span>loading shell</span>
      );
    }
    usePanelWindows.setState({ available: true });
    const dom = {
      version: 1,
      scroll: {},
      focus: { key: "draft", selection: { start: 1, end: 4, direction: "forward" } },
    };
    const staged = views.stage(
      offer,
      { version: 1, view: { version: 1, fields: {} }, dom },
      new AbortController().signal,
    );
    let complete = false;
    void staged.then(() => {
      complete = true;
    });
    const ui = render(
      <NativePanelView panelId={panelId}>
        <Renderer />
      </NativePanelView>,
    );
    try {
      expect(complete).toBe(false);
      // Commit cannot grant focus to an unresolved async tree either.
      await act(async () => {
        await views.reconcile({
          windows: [],
          panels: [{ ...lease, windowId: "target", generation: 2 }],
          transfers: [],
        });
      });
      expect(complete).toBe(false);
      await act(async () => {
        show();
      });
      expect(screen.getByRole("textbox")).not.toBe(document.activeElement);
      await act(async () => {
        ready();
        await staged;
      });
      expect(screen.getByRole("textbox")).toBe(document.activeElement);
      expect(screen.getByRole("textbox")).toHaveProperty("selectionStart", 1);
      expect(screen.getByRole("textbox")).toHaveProperty("selectionEnd", 4);
      expect(complete).toBe(true);
    } finally {
      ui.unmount();
      uninstall();
    }
  },
);

it("rolls back a throwing staged renderer without taking sibling panels down or ACKing an error fallback", async () => {
  const { act } = await import("@testing-library/react");
  const { createWindowViews, installWindowViews } = await import("@/lib/panels/windowViews");
  const { vi } = await import("vitest");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = { windowId: "target", control: vi.fn() } as unknown as PanelWindowClient;
  const views = createWindowViews(client),
    uninstall = installWindowViews(views);
  const lease = { panelId: "tasks", windowId: "source", generation: 1 };
  usePanelWindows.setState({ available: true });
  const pending = views.stage(
    { id: "throwing", lease, targetWindow: "target" },
    null,
    new AbortController().signal,
  );
  const check = expect(pending).rejects.toThrow("renderer exploded");
  function Broken(): never {
    throw new Error("renderer exploded");
  }
  try {
    await act(async () => {
      render(
        <>
          <button>unrelated panel</button>
          <NativePanelView panelId="tasks">
            <Broken />
          </NativePanelView>
        </>,
      );
    });
    await check;
    expect(screen.getByRole("button", { name: "unrelated panel" })).toBeTruthy();
    expect(useWindowViews.getState().entries.has("tasks")).toBe(false);
  } finally {
    cleanup();
    uninstall();
    error.mockRestore();
  }
});

it("restores the source caret on cancellation only after both local and native freeze are gone", async () => {
  const { act } = await import("@testing-library/react");
  const { createWindowViews, installWindowViews } = await import("@/lib/panels/windowViews");
  const { vi } = await import("vitest");
  const lease = { panelId: "tasks", windowId: "main", generation: 1 };
  const client = {
    windowId: "main",
    control: vi.fn().mockResolvedValue(null),
  } as unknown as PanelWindowClient;
  const views = createWindowViews(client),
    uninstall = installWindowViews(views);
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 500, height: 300 } as DOMRect);
  usePanelWindows.setState({
    available: true,
    snapshot: { windows: [], panels: [lease], transfers: [] },
  });
  await views.reconcile({ windows: [], panels: [lease], transfers: [] });
  const ui = render(
    <NativePanelView panelId="tasks">
      <input aria-label="source caret" data-panel-focus="draft" defaultValue="abcdef" />
    </NativePanelView>,
  );
  const input = screen.getByRole("textbox") as HTMLInputElement;
  try {
    input.focus();
    input.setSelectionRange(1, 4);
    await act(async () => {
      views.setMoving("tasks", true, lease);
    });
    input.blur();
    expect((await views.captureAsync("tasks")).dom.focus?.selection).toMatchObject({
      start: 1,
      end: 4,
    });
    const offer = { id: "pending", lease, targetWindow: "other" };
    await act(async () => {
      usePanelWindows.setState({
        snapshot: { windows: [], panels: [lease], transfers: [{ offer, ready: false }] },
      });
      views.setMoving("tasks", false, lease);
    });
    expect(document.activeElement).not.toBe(input);
    await act(async () => {
      usePanelWindows.setState({ snapshot: { windows: [], panels: [lease], transfers: [] } });
    });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(4);
  } finally {
    ui.unmount();
    uninstall();
    geometry.mockRestore();
  }
});
