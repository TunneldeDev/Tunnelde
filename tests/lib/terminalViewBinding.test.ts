import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api/ipc", () => ({ events: { onSshClosed: vi.fn().mockResolvedValue(vi.fn()) } }));
import { createTerminalViewBinding } from "@/features/terminal/terminalViewBinding";
import { terminalPreferenceProjection } from "@/features/terminal/terminalViewServices";
import {
  registerTerminalCheckpoint,
  beginTerminalHandoff,
} from "@/features/terminal/terminalCheckpoint";
import {
  encodeTerminalCheckpoint,
  decodeTerminalCheckpoint,
} from "@/features/terminal/terminalCheckpointCodec";
import { terminalCheckpointFixture } from "../fixtures/terminalCheckpoint";
import { createPanelViewState } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { TerminalWindowModel } from "@/features/terminal/terminalWindowModel";
const dispose: Array<() => void> = [];
afterEach(() => {
  for (const stop of dispose.splice(0).reverse()) stop();
  useWindowViews.setState({ entries: new Map() });
});
function fixture(staged = false, restored = false) {
  const id = "terminal:s1";
  const lease = { panelId: id, windowId: "target", generation: 2 };
  const controller = createPanelViewState(
    restored
      ? {
          version: 1,
          fields: { terminal: encodeTerminalCheckpoint(terminalCheckpointFixture(), "panel") },
        }
      : undefined,
  );
  const record: WindowViewRecord = {
    panelId: id,
    key: "same-tree",
    controller,
    staged,
    lease: staged ? undefined : lease,
  };
  useWindowViews.setState({ entries: new Map([[id, record]]) });
  usePanelWindows.setState({
    available: true,
    windowId: "target",
    snapshot: { windows: [], panels: staged ? [] : [lease], transfers: [] },
  });
  const client = {
    windowId: "target",
    terminals: {
      attach: vi.fn().mockResolvedValue(vi.fn()),
      detach: vi.fn().mockResolvedValue(7),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
    },
    action: vi.fn().mockResolvedValue(null),
  } as unknown as PanelWindowClient;
  const model: TerminalWindowModel = {
    appearance: {} as TerminalWindowModel["appearance"],
    language: "en-us",
    platform: "macos",
    terminal: {
      session: {
        id: "s1",
        hostId: "h1",
        title: "QA",
        address: "host:22",
        cols: 80,
        rows: 24,
        connectedAt: 0,
      },
      closed: false,
      disconnecting: false,
      providerSelected: false,
      preferences: terminalPreferenceProjection(DEFAULT_SETTINGS),
    },
  };
  const binding = createTerminalViewBinding(client, record, model);
  binding.mount();
  binding.activate(staged ? undefined : lease);
  dispose.push(
    () => controller.dispose(),
    () => binding.dispose(),
  );
  const participant = {
    prepare: vi.fn().mockResolvedValue(terminalCheckpointFixture()),
    resume: vi.fn().mockResolvedValue(undefined),
  };
  dispose.push(registerTerminalCheckpoint("s1", participant));
  return { id, lease, controller, record, client, model, binding, participant };
}
it("keeps staged attach pending until the exact destination lease is promoted", async () => {
  const f = fixture(true);
  const data = vi.fn();
  await f.binding.services.events.onSshData(data);
  const attaching = f.binding.services.io.sshAttach("s1");
  await Promise.resolve();
  expect(f.client.terminals.attach).not.toHaveBeenCalled();
  await expect(f.binding.services.io.sshWrite("s1", "bytes")).rejects.toThrow("staleOwner");
  useWindowViews.setState({
    entries: new Map([[f.id, { ...f.record, staged: false, lease: f.lease }]]),
  });
  f.binding.activate(f.lease);
  await attaching;
  expect(f.client.terminals.detach).toHaveBeenCalledWith(f.lease);
  expect(f.client.terminals.attach).toHaveBeenCalledWith(f.lease, expect.any(Function));
  vi.mocked(f.client.terminals.attach).mock.calls[0]![1]({ sequence: 8, data: "YWJj" });
  expect(data).toHaveBeenCalledWith({ sessionId: "s1", sequence: 8, data: "YWJj" });
});
it("rejects a wrong session selector and a retired renderer before any effect", async () => {
  const f = fixture();
  await expect(f.binding.services.io.sshWrite("another", "bytes")).rejects.toThrow("staleOwner");
  useWindowViews.setState({ entries: new Map([[f.id, { ...f.record, key: "replacement" }]]) });
  await expect(f.binding.services.io.sshWrite("s1", "bytes")).rejects.toThrow("staleOwner");
  expect(f.client.terminals.write).not.toHaveBeenCalled();
});
it("restores a real lossless checkpoint before acknowledging parser readiness", async () => {
  const f = fixture(true, true);
  expect(f.binding.services.checkpoints.take("s1")).toEqual(terminalCheckpointFixture());
  const ready = vi.fn();
  const waiting = f.controller.waitReady(new AbortController().signal).then(ready);
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  f.binding.services.rendered?.();
  await waiting;
  expect(ready).toHaveBeenCalledOnce();
  expect(f.client.terminals.attach).not.toHaveBeenCalled();
});
it("ordinary checkpoints resume immediately and do not retain a move reservation", async () => {
  const f = fixture();
  const captured = await f.controller.captureAsync(undefined, { intent: "checkpoint" });
  expect(decodeTerminalCheckpoint(captured.fields.terminal, "panel")).toEqual(
    terminalCheckpointFixture(),
  );
  expect(f.participant.resume).toHaveBeenCalledOnce();
  const next = await beginTerminalHandoff(["s1"]);
  await next.rollback();
});
it("a cancelled move rolls back the source, while native commit never reattaches it", async () => {
  const f = fixture();
  const moving = { ...f.record, moving: true };
  useWindowViews.setState({ entries: new Map([[f.id, moving]]) });
  await f.controller.captureAsync(undefined, { intent: "move" });
  expect(f.participant.resume).not.toHaveBeenCalled();
  useWindowViews.setState({ entries: new Map([[f.id, { ...f.record, moving: false }]]) });
  await vi.waitFor(() => expect(f.participant.resume).toHaveBeenCalledOnce());
  for (let i = 0; i < 15; i++) await Promise.resolve();
  useWindowViews.setState({ entries: new Map([[f.id, moving]]) });
  await f.controller.captureAsync(undefined, { intent: "move" });
  usePanelWindows.setState({
    snapshot: {
      windows: [],
      panels: [{ ...f.lease, windowId: "main", generation: 3 }],
      transfers: [],
    },
  });
  useWindowViews.setState({ entries: new Map() });
  await Promise.resolve();
  expect(f.participant.resume).toHaveBeenCalledOnce();
});
it("relays only closed terminal actions without a caller-chosen host or session", async () => {
  const f = fixture();
  await f.binding.services.updateFont("plex-mono");
  expect(f.client.action).toHaveBeenCalledWith(f.lease, {
    kind: "terminal",
    command: { operation: "font", font: "plex-mono" },
  });
  await f.binding.services.recordCommand("forged-host", "echo hello");
  expect(f.client.action).toHaveBeenLastCalledWith(f.lease, {
    kind: "terminal",
    command: { operation: "recordCommand", command: "echo hello" },
  });
});
