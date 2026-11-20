import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createPanelWindowClient } from "@/lib/panels/windowClient";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const lease = { panelId: "filePreview", windowId: "satellite", generation: 4 };
const target = { kind: "owned" as const, lease };

it("opens a private exact-target attachment and disposal closes only that display", async () => {
  vi.mocked(invoke).mockResolvedValue("panel-owned");
  const client = createPanelWindowClient({ windowId: "satellite", document: "native-document" });
  const handle = await client.openPreviewHandle(target, "resource-attempt");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("panel_window_control", {
    document: "native-document",
    request: { action: "openPreviewHandle", target, resourceId: "resource-attempt" },
  });
  handle.dispose();
  handle.dispose();
  client.dispose();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith("panel_window_control", {
    document: "native-document",
    request: { action: "closePreviewHandle", id: "panel-owned" },
  });
});

it.each(["cancel", "dispose"])("retires a late admitted handle after %s", async (kind) => {
  const pending = deferred<string>();
  vi.mocked(invoke).mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const client = createPanelWindowClient({ windowId: "satellite", document: "native-document" });
  const cancellation = new AbortController();
  const opening = client.openPreviewHandle(
    { kind: "staged", id: "offer" },
    "resource-attempt",
    cancellation.signal,
  );
  if (kind === "cancel") cancellation.abort();
  else client.dispose();
  pending.resolve("panel-late");
  await expect(opening).rejects.toBeDefined();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith("panel_window_control", {
    document: "native-document",
    request: { action: "closePreviewHandle", id: "panel-late" },
  });
  client.dispose();
});

it("an accepted display cancellation never closes the underlying preview ticket", async () => {
  vi.mocked(invoke).mockResolvedValue("panel-display");
  const client = createPanelWindowClient({ windowId: "satellite", document: "native-document" });
  const cancellation = new AbortController();
  const display = await client.openPreviewHandle(target, "resource", cancellation.signal);
  cancellation.abort();
  display.dispose();
  client.dispose();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(invoke).mock.calls.every(([command]) => command === "panel_window_control"),
  ).toBe(true);
});

it("does not acquire native capacity for a pre-cancelled display", async () => {
  const client = createPanelWindowClient({ windowId: "satellite", document: "native-document" });
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    client.openPreviewHandle(target, "resource", cancellation.signal),
  ).rejects.toBeDefined();
  expect(invoke).not.toHaveBeenCalled();
  client.dispose();
});
