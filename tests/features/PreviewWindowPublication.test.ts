import "@/i18n/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPreviewOwners, type PreviewOwner } from "@/features/sftp/preview/owner";
import { startPreviewWindowPublication } from "@/features/sftp/preview/windowPublication";
import { previewWindowData } from "@/features/sftp/preview/windowModel";
import type { PreviewReadSnapshot } from "@/features/sftp/preview/readSource";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import { usePanelWindows } from "@/store/panelWindows";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

const appearance = (): WindowModelAppearance => ({
  appearance: DEFAULT_SETTINGS,
  platform: "macos",
  language: "en-US",
});
const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const cleanups: (() => void)[] = [];
const initial = usePanelWindows.getState();
function panel(present = true) {
  usePanelWindows.setState({
    snapshot: {
      windows: [],
      transfers: [],
      panels: present ? [{ panelId: "filePreview", windowId: "main", generation: 1 }] : [],
    },
  });
}
function fixture(id = "attempt-one", ticket = "native-secret-ticket") {
  let read: PreviewReadSnapshot = {
    status: "ready",
    value: { info: { id: ticket, size: 123, renderer: "image" } },
  };
  const listeners = new Set<() => void>();
  const owner: PreviewOwner = {
    context: {
      snapshot: {
        id: "target",
        revision: "revision",
        attemptId: id,
        source: { kind: "remote", sessionId: "original-ssh" },
        path: "/photo.png",
        line: 0,
        column: 0,
        renderer: "image",
        providerId: "images:png",
        providerCount: 1,
        state: "ready",
        errorCode: null,
        presentation: "docked",
      },
      validateTarget: vi.fn(),
    } as unknown as FilePreviewContext,
    providers: [{ id: "images:png", name: "Images", renderer: "image" }],
    source: {
      snapshot: () => read,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retain: vi.fn(() => () => {}),
      fail: vi.fn(),
    },
  };
  return {
    owner,
    set(next: PreviewReadSnapshot) {
      read = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}
function setup(
  options: { present?: boolean; control?: (request: PanelWindowCommand) => Promise<unknown> } = {},
) {
  panel(options.present);
  const owners = createPreviewOwners();
  const mounted = owners.mount();
  cleanups.push(mounted.dispose);
  const control = vi.fn(
    options.control ?? (async (request) => (request.action === "beginModel" ? "publisher" : null)),
  );
  const failure = vi.fn();
  const publication = startPreviewWindowPublication(
    { control } as unknown as PanelWindowClient,
    appearance,
    failure,
    owners,
  );
  cleanups.push(publication.dispose);
  return { owners, mounted, control, failure, publication };
}
beforeEach(() => panel());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await settle();
  usePanelWindows.setState(initial, true);
});
it("publishes a ticket once before its credential-free model, and deduplicates appearance/metadata invalidations", async () => {
  const { mounted, control, publication, failure } = setup();
  const { owner } = fixture();
  mounted.publish(owner);
  await settle();
  const requests = control.mock.calls.map(([request]) => request);
  const resource = requests.findIndex(
    (request) => request.action === "publishPreviewResource" && request.resource !== null,
  );
  const model = requests.findIndex((request) => request.action === "publishModel");
  expect(resource).toBeGreaterThanOrEqual(0);
  expect(model).toBeGreaterThan(resource);
  expect(requests[model]).toMatchObject({
    model: {
      preview: {
        read: { status: "ready", resource: { id: "attempt-one", renderer: "image", size: 123 } },
      },
    },
  });
  expect(JSON.stringify(requests[model])).not.toContain("native-secret-ticket");
  for (let i = 0; i < 4; i++) {
    publication.refresh();
    panel();
    mounted.publish({ ...owner });
    await settle();
  }
  expect(
    control.mock.calls.filter(
      ([request]) => request.action === "publishPreviewResource" && request.resource,
    ),
  ).toHaveLength(1);
  expect(owner.source.retain).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
});
it("model publication notifications cannot feed back into another publication", async () => {
  const state = setup({
    control: async (request) => {
      panel();
      return request.action === "beginModel" ? "publisher" : null;
    },
  });
  state.mounted.publish(fixture().owner);
  await settle();
  const count = state.control.mock.calls.length;
  expect(count).toBeLessThan(10);
  await settle();
  expect(state.control).toHaveBeenCalledTimes(count);
});
it("waits for registration, follows only the active read and revokes failed/replaced resources", async () => {
  const state = setup({ present: false });
  const first = fixture();
  state.mounted.publish(first.owner);
  await settle();
  expect(state.control.mock.calls.some(([request]) => request.action === "beginModel")).toBe(false);
  panel();
  await settle();
  expect(first.listeners.size).toBe(1);
  first.set({ status: "error", stage: "decode", cause: new Error("native-secret-ticket") });
  await settle();
  const requests = state.control.mock.calls.map(([request]) => request);
  const lastModel = requests.filter((request) => request.action === "publishModel").at(-1);
  expect(lastModel).toMatchObject({
    model: { preview: { read: { status: "error", stage: "decode" } } },
  });
  expect(JSON.stringify(lastModel)).not.toContain("native-secret-ticket");
  const second = fixture("replacement", "second-ticket");
  state.mounted.publish(second.owner);
  await settle();
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(1);
  const count = state.control.mock.calls.length;
  first.set({ status: "loading" });
  await settle();
  expect(state.control).toHaveBeenCalledTimes(count);
  state.publication.dispose();
  await settle();
  expect(second.listeners.size).toBe(0);
  expect(state.control.mock.lastCall?.[0]).toEqual({
    action: "publishPreviewResource",
    resource: null,
  });
});
it("does not publish a stale target after an asynchronous beginModel receipt", async () => {
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const state = setup({
    control: async (request) => (request.action === "beginModel" ? pending : null),
  });
  state.mounted.publish(fixture().owner);
  await settle();
  state.mounted.publish(fixture("replacement", "new-ticket").owner);
  release("publisher");
  await settle();
  const models = state.control.mock.calls
    .map(([request]) => request)
    .filter((request) => request.action === "publishModel");
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    model: { preview: { snapshot: { attemptId: "replacement" } } },
  });
});
it("serializes restarted coordinators so late disposal cannot revoke the replacement resource", async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const old = setup({
    control: async (request) =>
      request.action === "publishPreviewResource" && request.resource
        ? pending
        : request.action === "beginModel"
          ? "old-publisher"
          : null,
  });
  old.mounted.publish(fixture().owner);
  await settle();
  const initialClears = old.control.mock.calls.filter(
    ([request]) => request.action === "publishPreviewResource" && !request.resource,
  ).length;
  old.publication.dispose();
  const next = setup();
  next.mounted.publish(fixture("new-attempt", "new-ticket").owner);
  release(null);
  await settle();
  expect(
    old.control.mock.calls.filter(
      ([request]) => request.action === "publishPreviewResource" && !request.resource,
    ),
  ).toHaveLength(initialClears);
  expect(next.control).toHaveBeenCalledWith({
    action: "publishPreviewResource",
    resource: { id: "new-attempt", ticket: "new-ticket" },
  });
  expect(next.failure).not.toHaveBeenCalled();
});
it("carries full bounded text in a private model, never in a transferable draft or public observation", () => {
  const value = fixture();
  const content = "\u0001".repeat(2 * 1024 * 1024);
  value.set({ status: "ready", value: { content, encoding: "utf-8" } });
  const model = previewWindowData(value.owner);
  expect(model.read).toEqual({ status: "ready", content, encoding: "utf-8" });
  expect(new TextEncoder().encode(JSON.stringify(model)).byteLength).toBeLessThan(16 * 1024 * 1024);
  expect(JSON.stringify(model.snapshot)).not.toContain("native-secret-ticket");
});
it("an obsolete registration cannot publish over or withdraw a replacement", () => {
  const owners = createPreviewOwners();
  const first = owners.mount();
  first.publish(fixture().owner);
  first.dispose();
  const second = owners.mount();
  const next = fixture("next").owner;
  second.publish(next);
  first.publish(fixture().owner);
  first.dispose();
  expect(owners.snapshot()?.context).toBe(next.context);
  second.dispose();
  expect(owners.snapshot()).toBeNull();
});

it("reacquires the model publisher when a panel registration changes without a visible empty snapshot", async () => {
  const state = setup();
  state.mounted.publish(fixture().owner);
  await settle();
  usePanelWindows.setState({
    snapshot: {
      windows: [],
      transfers: [],
      panels: [{ panelId: "filePreview", windowId: "main", generation: 9 }],
    },
  });
  await settle();
  expect(
    state.control.mock.calls.filter(([request]) => request.action === "beginModel"),
  ).toHaveLength(2);
  expect(
    state.control.mock.calls.filter(
      ([request]) => request.action === "publishPreviewResource" && request.resource,
    ),
  ).toHaveLength(1);
  expect(state.failure).not.toHaveBeenCalled();
});
