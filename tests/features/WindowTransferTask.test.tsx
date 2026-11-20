import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WindowTransferTask } from "@/features/sftp/WindowTransferTask";
import { PanelInteractionScope } from "@/lib/panels/interaction";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import type { TransferPanelModel } from "@/lib/panels/taskModel";
import type { TaskViewEntry } from "@/lib/panels/taskProjection";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { TransferWindowAction } from "@/features/sftp/transferWindowProtocol";
import { usePanelWindows } from "@/store/panelWindows";
import { useTransfers } from "@/store/transfers";
import { useSsh } from "@/store/ssh";
const lease = { panelId: "tasks", windowId: "satellite", generation: 1 };
const entry: TaskViewEntry = {
  id: "job",
  key: "transfers:job",
  source: "transfers",
  ticket: "ticket",
  title: "file",
  status: "paused",
  execution: "native",
  updatedAt: 1,
  actions: [],
  transfer: {
    item: {
      id: "job",
      name: "file",
      status: "paused",
      durable: true,
      updatedAt: 1,
      direction: "transfer",
      total: 100,
      transferred: 5,
      error: null,
      fromPath: "/from",
      toPath: "/to",
    },
    inspect: [],
  },
};
const task = { ...entry, actions: [] };
const host = {
  id: "h",
  name: "Remote",
  host: "example",
  username: "qa",
  port: 22,
  authMethod: "password" as const,
};
afterEach(() => {
  cleanup();
  usePanelWindows.setState({ windowId: "main", available: false });
  vi.restoreAllMocks();
});
function renderView(
  action: (request: TransferWindowAction) => Promise<unknown>,
  control = vi.fn<(request: PanelWindowCommand) => Promise<unknown>>().mockResolvedValue("guard"),
) {
  usePanelWindows.setState({ windowId: "satellite" });
  const state = createPanelViewState();
  const model: TransferPanelModel = {
    entries: [entry],
    action: action as TransferPanelModel["action"],
  };
  const result = render(
    <PanelViewStateScope controller={state}>
      <PanelInteractionScope
        value={{ lease, staged: false, client: { control } as unknown as PanelWindowClient }}
      >
        <WindowTransferTask task={task} now={1} model={model} />
      </PanelInteractionScope>
    </PanelViewStateScope>,
  );
  return { ...result, state, control };
}
it("does not run transfer or credential effects on mount; acquires consent before prompt effects and cancel never resumes", async () => {
  let ready!: (id: string) => void;
  const control = vi.fn<(request: PanelWindowCommand) => Promise<unknown>>((request) =>
    request.action === "beginInteraction"
      ? new Promise((resolve) => {
          ready = resolve;
        })
      : Promise.resolve(null),
  );
  const action = vi.fn(async (request: TransferWindowAction) => {
    if (request.kind === "transferResume") return { prompt: { handle: "p", host } };
    if (request.kind !== "transferPrompt") throw new Error("unexpected");
    if (request.command.operation === "prepare") return { jumpHosts: [], saved: {} };
    if (request.command.operation === "probe")
      return { hostId: "h", fingerprint: "SHA256:key", status: "known" };
    if (request.command.operation === "close") return null;
    throw new Error("unexpected");
  });
  const raw = vi.spyOn(useTransfers.getState(), "resume"),
    ssh = vi.spyOn(useSsh.getState(), "connect");
  renderView(action, control);
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Resume transfer" }));
  await waitFor(() => expect(control).toHaveBeenCalledWith({ action: "beginInteraction", lease }));
  expect(action).not.toHaveBeenCalled();
  await act(async () => ready("guard"));
  await screen.findByText("SHA256:key");
  expect(action.mock.calls[0]?.[0]).toEqual({
    kind: "transferResume",
    key: entry.key,
    ticket: entry.ticket,
    interaction: "guard",
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(action.mock.calls.filter(([r]) => r.kind === "transferResume")).toHaveLength(1);
  expect(control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "guard" });
  expect(raw).not.toHaveBeenCalled();
  expect(ssh).not.toHaveBeenCalled();
});
it("keeps typed credentials out of the view capsule and advances sequential endpoint prompts under one guard", async () => {
  let resumes = 0;
  const action = vi.fn(async (request: TransferWindowAction) => {
    if (request.kind === "transferResume") {
      resumes++;
      return resumes <= 2
        ? {
            prompt: {
              handle: `p${resumes}`,
              host: { ...host, id: `h${resumes}`, name: `Remote ${resumes}` },
            },
          }
        : {};
    }
    if (request.kind !== "transferPrompt") throw new Error("unexpected");
    if (request.command.operation === "prepare") return { jumpHosts: [], saved: {} };
    if (request.command.operation === "probe")
      return { fingerprint: "SHA256:key", status: "known" };
    if (request.command.operation === "connect") return { id: "session" };
    return null;
  });
  const { state, control } = renderView(action);
  fireEvent.click(screen.getByRole("button", { name: "Resume transfer" }));
  for (const n of [1, 2]) {
    await screen.findByRole("dialog", { name: `Connect to Remote ${n}` });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: `private-secret-${n}` },
    });
    expect(JSON.stringify(state.capture())).not.toContain("private-secret");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(resumes).toBe(3);
  expect(
    control.mock.calls.filter(([request]) => request.action === "beginInteraction"),
  ).toHaveLength(1);
  expect(
    action.mock.calls
      .filter(([r]) => r.kind === "transferPrompt" && r.command.operation === "connect")
      .map(([r]) => r),
  ).toEqual(
    [1, 2].map((n) => ({
      kind: "transferPrompt",
      key: entry.key,
      ticket: entry.ticket,
      interaction: "guard",
      handle: `p${n}`,
      command: {
        operation: "connect",
        password: `private-secret-${n}`,
        passphrase: null,
        credentials: {},
      },
    })),
  );
  expect(control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "guard" });
});
it("releases a late consent acquisition after unmount without starting any action", async () => {
  let ready!: (id: string) => void;
  const control = vi.fn<(request: PanelWindowCommand) => Promise<unknown>>((request) =>
    request.action === "beginInteraction"
      ? new Promise((resolve) => {
          ready = resolve;
        })
      : Promise.resolve(null),
  );
  const action = vi.fn();
  const { unmount } = renderView(action, control);
  fireEvent.click(screen.getByRole("button", { name: "Resume transfer" }));
  await waitFor(() => expect(control).toHaveBeenCalledOnce());
  unmount();
  await act(async () => ready("late"));
  expect(action).not.toHaveBeenCalled();
  expect(control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "late" });
});
it("uses explicit task controls rather than generic source actions or local stores", async () => {
  const action = vi.fn().mockResolvedValue(null);
  usePanelWindows.setState({ windowId: "satellite" });
  const running = {
    ...entry,
    transfer: { ...entry.transfer!, item: { ...entry.transfer!.item, status: "running" as const } },
  };
  render(<WindowTransferTask task={task} now={1} model={{ entries: [running], action }} />);
  fireEvent.click(screen.getByRole("button", { name: "Pause transfer" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith({
      kind: "transfer",
      key: entry.key,
      ticket: entry.ticket,
      command: { operation: "pause" },
    }),
  );
});
it("lets users dismiss an expired prompt even if its coordinator close handle is gone", async () => {
  const action = vi.fn(async (request: TransferWindowAction) => {
    if (request.kind === "transferResume") return { prompt: { handle: "expired", host } };
    if (request.kind !== "transferPrompt") throw new Error("unexpected");
    if (request.command.operation === "prepare") return { jumpHosts: [], saved: {} };
    if (request.command.operation === "probe") return { fingerprint: "key", status: "known" };
    throw new Error("panel.window.staleOwner");
  });
  const { control } = renderView(action);
  fireEvent.click(screen.getByRole("button", { name: "Resume transfer" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "guard" });
});
