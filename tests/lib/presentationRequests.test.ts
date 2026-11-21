import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { FloatingPanelState } from "@/store/panelPresentation";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelPresentationJob, PanelWindowCommand } from "@/lib/panels/windowProtocol";
import { createLocalPanelWorkspace } from "@/lib/panels/localWorkspace";
import { createLocalPanelPresentation } from "@/lib/panels/localPresentation";
import {
  installSourcePanelPresentation,
  type SourcePanelPresentation,
} from "@/lib/panels/sourcePresentation";
import {
  panelLayoutMetadata,
  startPresentationRequests,
  publishStagedPresentation,
} from "@/lib/panels/presentationRequests";
const stops: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
  vi.useRealTimers();
});
const lease = { panelId: "tasks", windowId: "source", generation: 4 };
const job: PanelPresentationJob = {
  id: "native-job",
  lease,
  operation: { kind: "set", presentation: "floating" },
};
function fixture() {
  const workspace = createLocalPanelWorkspace();
  workspace.reconcile(["tasks"]);
  const slots = new Map([
    [
      "tasks",
      createStore<FloatingPanelState>(() => ({ pinned: true, bounds: null }) as FloatingPanelState),
    ],
  ]);
  const host = createLocalPanelPresentation("source", workspace, () => slots);
  let notify = () => {};
  const control = vi.fn(async (_request: PanelWindowCommand): Promise<unknown> => null);
  const claim = vi.fn().mockResolvedValue([]),
    complete = vi.fn().mockResolvedValue(null),
    fail = vi.fn().mockResolvedValue(null),
    failure = vi.fn(),
    unlisten = vi.fn();
  const client = {
    windowId: "source",
    snapshot: vi.fn().mockResolvedValue({ windows: [], panels: [lease], transfers: [] }),
    control,
    claimPresentations: claim,
    completePresentation: complete,
    failPresentation: fail,
    subscribe: vi.fn(async (fn: () => void) => {
      notify = fn;
      return unlisten;
    }),
  } as unknown as PanelWindowClient;
  return {
    host,
    workspace,
    slots,
    client,
    control,
    claim,
    complete,
    fail,
    failure,
    notify: () => notify(),
    unlisten,
  };
}
const flush = async () => {
  await vi.advanceTimersByTimeAsync(45);
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it("publishes explicit metadata only, ignores unchanged invalidations and updates real source layout", async () => {
  const f = fixture();
  const read = f.host.read;
  f.host.read = () => read().map((row) => ({ ...row, password: "private extra field" }));
  stops.push(installSourcePanelPresentation(f.host));
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  const publication = f.control.mock.calls.find(([r]) => r.action === "publishPresentation")![0];
  expect(publication).toEqual({
    action: "publishPresentation",
    lease,
    metadata: {
      presentation: "workspace",
      visible: true,
      pinned: true,
      bounds: null,
      available: true,
      presentations: ["workspace", "floating"],
    },
  });
  expect(JSON.stringify(publication)).not.toContain("private");
  const count = f.control.mock.calls.length;
  f.notify();
  await flush();
  expect(f.control).toHaveBeenCalledTimes(count);
  f.host.close("tasks");
  await flush();
  expect(f.control).toHaveBeenLastCalledWith(
    expect.objectContaining({ metadata: expect.objectContaining({ visible: false }) }),
  );
  expect(f.failure).not.toHaveBeenCalled();
});
it("waits for native admission, mutates this source synchronously then finalizes its actual result", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  f.claim.mockResolvedValueOnce([job]);
  let admit!: (value: unknown) => void;
  f.control.mockImplementation(async (r) =>
    r.action === "beginPresentation"
      ? new Promise((resolve) => {
          admit = resolve;
        })
      : null,
  );
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  expect(f.host.read()[0]?.presentation).toBe("workspace");
  expect(f.complete).not.toHaveBeenCalled();
  admit(null);
  await flush();
  expect(f.host.read()[0]?.presentation).toBe("floating");
  expect(f.complete).toHaveBeenCalledExactlyOnceWith(
    job.id,
    expect.objectContaining({ presentation: "floating", visible: true }),
  );
  expect(f.fail).not.toHaveBeenCalled();
});
it("disposal and adapter replacement after begin never mutate a retired or replacement source", async () => {
  for (const replace of [false, true]) {
    const f = fixture();
    const uninstall = installSourcePanelPresentation(f.host);
    stops.push(uninstall);
    f.claim.mockResolvedValueOnce([job]);
    let admit!: (value: unknown) => void;
    f.control.mockImplementation(async (r) =>
      r.action === "beginPresentation"
        ? new Promise((resolve) => {
            admit = resolve;
          })
        : null,
    );
    const stop = startPresentationRequests(f.client, f.failure);
    stops.push(stop);
    await flush();
    let replacement: SourcePanelPresentation | undefined;
    if (replace) {
      uninstall();
      replacement = fixture().host;
      stops.push(installSourcePanelPresentation(replacement));
    } else stop();
    admit(null);
    await flush();
    expect(f.host.read()[0]?.presentation).toBe("workspace");
    expect(replacement?.read()[0]?.presentation ?? "workspace").toBe("workspace");
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledWith(job.id);
    stop();
    if (replace) {
      stops.pop()!();
    }
    uninstall();
  }
});
it("late claims are released after disposal and admission failure never applies a UI effect", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  let claimed!: (jobs: PanelPresentationJob[]) => void;
  f.claim.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        claimed = resolve;
      }),
  );
  const stop = startPresentationRequests(f.client, f.failure);
  stops.push(stop);
  await flush();
  stop();
  claimed([job]);
  await flush();
  expect(f.fail).toHaveBeenCalledWith(job.id);
  expect(f.control).not.toHaveBeenCalledWith({ action: "beginPresentation", id: job.id });
  expect(f.host.read()[0]?.presentation).toBe("workspace");
});
it("releases rejected or partially failed source operations without relaying private error text", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  f.claim.mockResolvedValueOnce([job]);
  f.host.set = () => {
    throw new Error("secret local draft failure");
  };
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  expect(f.fail).toHaveBeenCalledExactlyOnceWith(job.id);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.fail.mock.calls)).not.toContain("secret");
});
it("publishes target-scoped staged metadata only when the actual adapter is ready", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  const offer = { id: "offer", lease: { ...lease, windowId: "main" }, targetWindow: "source" };
  await publishStagedPresentation(f.client, offer);
  expect(f.control).toHaveBeenCalledExactlyOnceWith({
    action: "publishStagedPresentation",
    id: "offer",
    metadata: expect.objectContaining({ presentation: "workspace", visible: true }),
  });
  f.host.readStaged = () => undefined;
  await expect(publishStagedPresentation(f.client, offer)).rejects.toThrow("viewNotReady");
  f.host.readStaged = () => ({ ...f.host.read()[0]!, windowId: "other" });
  await expect(publishStagedPresentation(f.client, offer)).rejects.toThrow("viewNotReady");
  expect(f.control).toHaveBeenCalledOnce();
});
it("publishes the unavailable preview catalogue row from main without fabricating a live preview", async () => {
  const f = fixture();
  const host = f.host;
  host.read = () => [];
  host.readStaged = (id) =>
    id === "filePreview"
      ? {
          id,
          windowId: "main",
          presentation: "sidebar",
          visible: false,
          pinned: false,
          bounds: null,
          available: false,
          presentations: ["sidebar", "workspace", "floating"],
        }
      : undefined;
  stops.push(installSourcePanelPresentation(host));
  Object.assign(f.client, { windowId: "main" });
  vi.mocked(f.client.snapshot).mockResolvedValue({ windows: [], panels: [], transfers: [] });
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  expect(f.control).toHaveBeenCalledExactlyOnceWith({
    action: "publishUnavailablePreview",
    metadata: expect.objectContaining({ available: false, visible: false }),
  });
});

it("rejects a claimed job or metadata from another source window", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  f.claim.mockResolvedValueOnce([{ ...job, lease: { ...lease, windowId: "alien" } }]);
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  expect(f.control).not.toHaveBeenCalledWith({ action: "beginPresentation", id: job.id });
  expect(f.fail).toHaveBeenCalledWith(job.id);
  expect(f.complete).not.toHaveBeenCalled();
  const read = f.host.read;
  f.host.read = () => read().map((row) => ({ ...row, windowId: "alien" }));
  f.notify();
  await flush();
  expect(f.failure).toHaveBeenCalled();
  expect(f.control.mock.calls.filter(([r]) => r.action === "publishPresentation")).toHaveLength(1);
});

it("projects geometry fields rather than spreading future adapter-private values", () => {
  const row = fixture().host.read()[0]!;
  const bounds = { x: -3, y: 5, width: 400, height: 200, draft: "secret geometry field" };
  expect(panelLayoutMetadata({ ...row, bounds }).bounds).toEqual({
    x: -3,
    y: 5,
    width: 400,
    height: 200,
  });
});

it("reserves only the active panel publication lane through completion", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  f.claim.mockResolvedValueOnce([job]);
  let admit!: (value: unknown) => void;
  let completed!: (value: unknown) => void;
  f.control.mockImplementation(async (r) =>
    r.action === "beginPresentation"
      ? new Promise((resolve) => {
          admit = resolve;
        })
      : null,
  );
  f.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completed = resolve;
      }),
  );
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  const publications = () =>
    f.control.mock.calls.filter(([r]) => r.action === "publishPresentation");
  expect(publications()).toHaveLength(1);
  admit(null);
  await flush();
  expect(f.host.read()[0]?.presentation).toBe("floating");
  const outputLease = { ...lease, panelId: "output" };
  f.slots.set(
    "output",
    createStore<FloatingPanelState>(() => ({ pinned: true, bounds: null }) as FloatingPanelState),
  );
  f.workspace.reconcile(["tasks", "output"]);
  vi.mocked(f.client.snapshot).mockResolvedValue({
    windows: [],
    panels: [lease, outputLease],
    transfers: [],
  });
  f.notify();
  await flush();
  expect(publications()).toHaveLength(2);
  expect(publications()[1]![0]).toMatchObject({ lease: outputLease });
  completed(null);
  await flush();
  await flush();
  expect(publications()).toHaveLength(3);
  expect(publications()[2]![0]).toMatchObject({ lease, metadata: { presentation: "floating" } });
});

it("does not release a newer job's publication lane when the older completion reply arrives late", async () => {
  const f = fixture();
  stops.push(installSourcePanelPresentation(f.host));
  f.claim.mockResolvedValueOnce([job]);
  let oldReply!: (value: unknown) => void;
  f.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        oldReply = resolve;
      }),
  );
  stops.push(startPresentationRequests(f.client, f.failure));
  await flush();
  const next = { ...job, id: "new-native-job", operation: { kind: "close" as const } };
  let newAdmission!: (value: unknown) => void;
  f.control.mockImplementation(async (r) =>
    r.action === "beginPresentation" && r.id === next.id
      ? new Promise((resolve) => {
          newAdmission = resolve;
        })
      : null,
  );
  f.claim.mockResolvedValueOnce([next]);
  f.notify();
  await flush();
  oldReply(null);
  await flush();
  f.notify();
  await flush();
  const publications = () =>
    f.control.mock.calls.filter(([r]) => r.action === "publishPresentation");
  expect(publications()).toHaveLength(1);
  newAdmission(null);
  await flush();
  await flush();
  expect(f.host.read()[0]?.visible).toBe(false);
  expect(publications().at(-1)![0]).toMatchObject({ metadata: { visible: false } });
  expect(f.fail).not.toHaveBeenCalled();
});
