import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPluginInstall } from "@/features/plugins/LocalPluginInstall";
import i18n from "@/i18n/i18n";
import { deferred, plugin } from "../fixtures/plugins";
const mock = vi.hoisted(() => ({ listen: vi.fn(), inspect: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mock.listen }),
}));
vi.mock("@/lib/api/ipc", () => ({ api: { pluginInspect: mock.inspect }, isTauri: () => true }));
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  mock.listen.mockResolvedValue(vi.fn());
  mock.inspect.mockResolvedValue(plugin);
});
describe("native plugin package drops", () => {
  it("ignores hidden sidebars and re-inspects a repeated package drop", async () => {
    const { container, rerender } = render(
      <aside className="plugins-sidebar" hidden>
        <LocalPluginInstall request={0} />
      </aside>,
    );
    const hit = vi.fn(() => container.querySelector("aside"));
    const original = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
    try {
      await waitFor(() => expect(mock.listen).toHaveBeenCalledOnce());
      const onDrop = mock.listen.mock.calls[0]![0] as (event: unknown) => void;
      const event = {
        payload: {
          type: "drop",
          paths: ["D:\\plugins\\formatter.zip"],
          position: { x: 10, y: 10 },
        },
      };
      act(() => onDrop(event));
      expect(mock.inspect).not.toHaveBeenCalled();
      rerender(
        <aside className="plugins-sidebar">
          <LocalPluginInstall request={0} />
        </aside>,
      );
      act(() => onDrop(event));
      await screen.findByText("Formatter", { selector: "strong" });
      expect(mock.inspect).toHaveBeenCalledOnce();
      act(() => onDrop(event));
      await waitFor(() => expect(mock.inspect).toHaveBeenCalledTimes(2));
      expect(mock.inspect).toHaveBeenLastCalledWith("D:\\plugins\\formatter.zip");
    } finally {
      if (original) Object.defineProperty(document, "elementFromPoint", original);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("disposes a native listener that finishes registering after unmount", async () => {
    const listener = deferred<() => void>(),
      dispose = vi.fn();
    mock.listen.mockReturnValue(listener.promise);
    const view = render(<LocalPluginInstall request={0} />);
    view.unmount();
    await act(async () => {
      listener.resolve(dispose);
      await listener.promise;
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
