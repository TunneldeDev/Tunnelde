import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPanelViewState,
  parsePanelViewCapsule,
  PanelViewStateScope,
  usePanelViewState,
} from "@/lib/panels/viewState";
afterEach(cleanup);
const isString = (value: unknown): value is string => typeof value === "string";
function Draft({ name = "password" }: { name?: string }) {
  const [value, set] = usePanelViewState(name, "", isString);
  return <input aria-label={name} value={value} onChange={(event) => set(event.target.value)} />;
}
it("captures explicit state in memory and restores without writing any preferences", () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const source = createPanelViewState();
  const view = render(
    <PanelViewStateScope controller={source}>
      <Draft />
    </PanelViewStateScope>,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "secret draft" } });
  const snapshot = source.capture();
  expect(snapshot).toEqual({ version: 1, fields: { password: "secret draft" } });
  view.unmount();
  const destination = createPanelViewState(snapshot);
  render(
    <StrictMode>
      <PanelViewStateScope controller={destination}>
        <Draft />
      </PanelViewStateScope>
    </StrictMode>,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", "secret draft");
  expect(destination.capture()).toEqual(snapshot);
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});
it("keeps panels isolated and drops closed dialog drafts instead of reviving them", () => {
  const controller = createPanelViewState({ version: 1, fields: { password: "old" } });
  const view = render(
    <PanelViewStateScope controller={controller}>
      <Draft />
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", "old");
  view.rerender(<PanelViewStateScope controller={controller}>{null}</PanelViewStateScope>);
  expect(controller.capture().fields).toEqual({});
  view.rerender(
    <PanelViewStateScope controller={controller}>
      <Draft />
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  const other = createPanelViewState();
  expect(other.capture().fields).toEqual({});
});
it("supports ordinary React state without a window owner and rejects incompatible field schemas", () => {
  const controller = createPanelViewState({
    version: 1,
    fields: { password: { oldSchema: true } },
  });
  const view = render(
    <PanelViewStateScope controller={controller}>
      <Draft />
    </PanelViewStateScope>,
  );
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  view.unmount();
  render(<Draft />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "normal" } });
  expect(screen.getByRole("textbox")).toHaveProperty("value", "normal");
});
it("validates capsule size/version/keys and refuses non-JSON or cyclic live state", () => {
  for (const value of [
    null,
    [],
    { version: 2, fields: {} },
    { version: 1, fields: [] },
    { version: 1, fields: { constructor: "bad" } },
  ])
    expect(() => parsePanelViewCapsule(value)).toThrow();
  expect(() =>
    parsePanelViewCapsule({ version: 1, fields: { text: "x".repeat(1024 * 1024) } }),
  ).toThrow("tooLarge");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [
    undefined,
    Infinity,
    NaN,
    () => {},
    Symbol(),
    BigInt(1),
    cyclic,
    new Map(),
    new Date(),
    new Array(3),
  ]) {
    const controller = createPanelViewState();
    controller.register("draft", () => value);
    expect(() => controller.capture()).toThrow();
  }
  const shared = { text: "same" };
  expect(
    parsePanelViewCapsule({ version: 1, fields: { first: shared, second: shared } }).fields,
  ).toEqual({ first: shared, second: shared });
});
it("fences duplicate registrations and obsolete cleanup; disposal clears all secret references", () => {
  const controller = createPanelViewState();
  const release = controller.register("draft", () => "first");
  expect(() => controller.register("draft", () => "duplicate")).toThrow("duplicateKey");
  release();
  const second = controller.register("draft", () => "second");
  release();
  expect(controller.capture().fields).toEqual({ draft: "second" });
  second();
  controller.dispose();
  expect(() => controller.capture()).toThrow("disposed");
  expect(() => controller.register("draft", () => "third")).toThrow("disposed");
});

it("bounds nested data and rejects getters without calling them", () => {
  const getter = vi.fn(() => "secret");
  const state = Object.defineProperty({}, "value", { get: getter, enumerable: true });
  expect(() => parsePanelViewCapsule({ version: 1, fields: { state } })).toThrow("invalid");
  expect(getter).not.toHaveBeenCalled();
  let deep: unknown = "draft";
  for (let n = 0; n < 100; n++) deep = { next: deep };
  expect(() => parsePanelViewCapsule({ version: 1, fields: { deep } })).toThrow("tooLarge");
});
it("notifies checkpoint observers after committed React state, and releases them on disposal", () => {
  const controller = createPanelViewState();
  const view = render(
    <PanelViewStateScope controller={controller}>
      <Draft />
    </PanelViewStateScope>,
  );
  const snapshots: unknown[] = [];
  const stop = controller.subscribe(() => snapshots.push(controller.capture()));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new private draft" } });
  expect(snapshots).toEqual([{ version: 1, fields: { password: "new private draft" } }]);
  stop();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "not observed" } });
  expect(snapshots).toHaveLength(1);
  view.unmount();
  controller.dispose();
  controller.changed();
  expect(() => controller.subscribe(() => {})).toThrow("disposed");
});
