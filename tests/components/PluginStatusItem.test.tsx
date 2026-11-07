import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PluginStatusItem } from "@/components/layout/PluginStatusItem";
import { orderStatusItems, type PluginStatusBarItem } from "@/lib/plugins/statusBar";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/i18n/i18n", () => ({ default: { language: "en-US", t: (key: string) => key } }));
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));
const item: PluginStatusBarItem = {
  id: "status",
  pluginId: "example",
  pluginName: "Example",
  token: "opaque",
  text: "<b>Ready</b>",
  alignment: "left",
  priority: 0,
  tooltip: "Open details",
  command: null,
  icon: "check",
};

it("renders plain text with plugin identity and no clickable control for informational items", () => {
  const { container } = render(<PluginStatusItem item={item} />);
  expect(screen.getByLabelText("Example: Open details").textContent).toBe("<b>Ready</b>");
  expect(container.querySelector("b")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

it("executes the host-issued click identity and prevents duplicate pending clicks", async () => {
  let complete!: () => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = () => resolve(null);
      }),
  );
  render(<PluginStatusItem item={{ ...item, command: "details" }} />);
  const button = screen.getByRole("button");
  fireEvent.click(button);
  fireEvent.click(button);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("plugin_status_bar_execute", {
    token: "opaque",
    locale: "en-US",
  });
  expect(button.getAttribute("aria-busy")).toBe("true");
  complete();
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("false"));
});

it("orders priorities descending with locale-independent ID tie breaking", () => {
  expect(
    orderStatusItems([
      { id: "z", priority: 0 },
      { id: "a", priority: 0 },
      { id: "b", priority: 1 },
    ]).map((value) => value.id),
  ).toEqual(["b", "a", "z"]);
});
