import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WindowForwardingConnectDialog } from "@/features/forwarding/components/WindowForwardingConnectDialog";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { ForwardingWindowMutation } from "@/features/forwarding/runtime/windowProtocol";
import { usePanelWindows } from "@/store/panelWindows";
const raw = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: raw.invoke }));
afterEach(() => {
  cleanup();
  usePanelWindows.setState({ windowId: "main", available: false });
  expect(raw.invoke).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
const lease = { panelId: "forwarding", windowId: "satellite", generation: 2 };
const rule = { id: "rule", revision: "original-revision", hostId: "h" };
const host = {
  id: "h",
  name: "Remote",
  host: "example",
  username: "qa",
  port: 22,
  authMethod: "password" as const,
};
const info = { hostId: "h", status: "known", fingerprint: "SHA256:reviewed" };
const session = { id: "s", hostId: "h", purpose: "forwarding", address: "qa@example:22" };
const plan = { host, jumpHosts: [], review: { hostId: "h", revision: "a".repeat(64) } };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  handler: (r: ForwardingWindowMutation) => Promise<unknown> = async (r) =>
    r.operation === "probe"
      ? info
      : r.operation === "credentialStatus"
        ? true
        : r.operation === "start"
          ? session
          : null,
) {
  usePanelWindows.setState({ windowId: "satellite" });
  let serial = 0;
  const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
    r.action === "beginInteraction" ? `origin-${++serial}` : null,
  );
  const mutation = vi.fn(async (_lease: unknown, r: ForwardingWindowMutation): Promise<unknown> =>
    r.operation === "prepareStart" ? structuredClone(plan) : handler(r),
  );
  const client = { control, forwardingMutation: mutation } as unknown as PanelWindowClient;
  const close = vi.fn(),
    done = vi.fn();
  const element = (target = rule, callback = done) => (
    <WindowForwardingConnectDialog
      client={client}
      lease={{ ...lease }}
      rule={{ ...target }}
      onClose={close}
      onConnected={callback}
    />
  );
  return { control, mutation, client, close, done, element };
}
it("does not mount interactive consent or effects until original native interaction is acquired; cancel releases a late token", async () => {
  const f = fixture();
  const admitted = deferred<unknown>();
  f.control.mockImplementation((r) =>
    r.action === "beginInteraction" ? admitted.promise : Promise.resolve(null),
  );
  const view = render(f.element());
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(f.mutation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(f.close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  await act(async () => {
    admitted.resolve("late-original");
  });
  await waitFor(() =>
    expect(f.control).toHaveBeenLastCalledWith({
      action: "endInteraction",
      lease,
      id: "late-original",
    }),
  );
  expect(f.mutation).not.toHaveBeenCalled();
});
it("uses the actual shared prompt in a satellite, serializing initial effects and keeping completion in its originating window", async () => {
  let active = 0,
    max = 0;
  const f = fixture(async (r) => {
    active++;
    max = Math.max(max, active);
    await Promise.resolve();
    active--;
    return r.operation === "probe"
      ? info
      : r.operation === "credentialStatus"
        ? true
        : r.operation === "start"
          ? session
          : null;
  });
  const view = render(f.element());
  await screen.findByText("Trusted");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", false),
  );
  expect(max).toBe(1);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "request-only" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  expect(f.done).toHaveBeenCalledExactlyOnceWith(session);
  expect(screen.queryByRole("dialog")).toBeNull();
  const sent = f.mutation.mock.calls.map(([, r]) => r);
  expect(sent.find((r) => r.operation === "start")).toMatchObject({
    id: "rule",
    revision: rule.revision,
    interaction: "origin-1",
    credentials: { password: "request-only" },
  });
  expect(sent.find((r) => r.operation === "saveCredential")).toMatchObject({
    hostId: "h",
    password: "request-only",
    interaction: "origin-1",
  });
  view.unmount();
  await waitFor(() =>
    expect(f.control.mock.calls.filter(([r]) => r.action === "endInteraction")).toHaveLength(1),
  );
});
it("keeps nested forget confirmation local and bound to original native consent, including a rejected forget", async () => {
  let failed = false;
  const f = fixture(async (r) => {
    if (r.operation === "forgetCredential" && !failed) {
      failed = true;
      throw new Error("keyring locked");
    }
    return r.operation === "probe" ? info : r.operation === "credentialStatus" ? true : null;
  });
  render(f.element());
  fireEvent.click(await screen.findByRole("button", { name: "Forget" }));
  const confirm = screen.getAllByRole("dialog").at(-1)!;
  fireEvent.click(within(confirm).getByRole("button", { name: "Forget" }));
  await waitFor(() =>
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(f.mutation.mock.calls.filter(([, r]) => r.operation === "forgetCredential")).toHaveLength(
    1,
  );
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  fireEvent.click(within(confirm).getByRole("button", { name: "Forget" }));
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
  const forgotten = f.mutation.mock.calls.filter(([, r]) => r.operation === "forgetCredential");
  expect(forgotten).toHaveLength(2);
  expect(forgotten.every(([, r]) => "interaction" in r && r.interaction === "origin-1")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "origin-1" }),
  );
});
it("does not reacquire consent or restart probes for equivalent refreshed model objects and uses current callbacks", async () => {
  const f = fixture();
  const view = render(f.element());
  await screen.findByText("Trusted");
  const current = vi.fn();
  view.rerender(f.element({ ...rule }, current));
  expect(f.control.mock.calls.filter(([r]) => r.action === "beginInteraction")).toHaveLength(1);
  expect(f.mutation.mock.calls.filter(([, r]) => r.operation === "probe")).toHaveLength(1);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(current).toHaveBeenCalledExactlyOnceWith(session));
  expect(f.done).not.toHaveBeenCalled();
});
it("retires a pending old target before mounting replacement consent and never delivers its late preparation", async () => {
  const f = fixture();
  const old = deferred<unknown>();
  f.mutation.mockImplementationOnce(() => old.promise);
  const view = render(f.element());
  await waitFor(() => expect(f.mutation).toHaveBeenCalledTimes(1));
  view.rerender(f.element({ ...rule, revision: "replacement-revision" }));
  await screen.findByText("Trusted");
  await act(async () => old.resolve(plan));
  expect(f.control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "origin-1" });
  const probes = f.mutation.mock.calls.filter(([, r]) => r.operation === "probe");
  expect(probes).toHaveLength(1);
  expect(probes[0]?.[1]).toMatchObject({
    revision: "replacement-revision",
    interaction: "origin-2",
  });
});
it("clears typed credentials and disables further connection when the displayed rule changed", async () => {
  const f = fixture(async (r) => {
    if (r.operation === "start") throw { code: "validation", message: "forward.changed" };
    return r.operation === "probe" ? info : r.operation === "credentialStatus" ? true : null;
  });
  render(f.element());
  await screen.findByText("Trusted");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "must-clear" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(screen.getByLabelText("Password")).toHaveProperty("value", ""));
  expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
  expect(f.done).not.toHaveBeenCalled();
});
it("strict lifecycle replay releases retired pending origins rather than duplicating prompt effects", async () => {
  const f = fixture();
  render(<StrictMode>{f.element()}</StrictMode>);
  await screen.findByText("Trusted");
  expect(f.control.mock.calls.filter(([r]) => r.action === "beginInteraction")).toHaveLength(2);
  expect(f.control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "origin-1" });
  expect(f.mutation.mock.calls.filter(([, r]) => r.operation === "prepareStart")).toHaveLength(1);
});

it("uses the shared production prompt exclusively through an original native provider child", async () => {
  const f = fixture();
  const providerMutation = vi.fn(
    async (_token: string, _lease: unknown, r: ForwardingWindowMutation): Promise<unknown> =>
      r.operation === "prepareStart"
        ? structuredClone(plan)
        : r.operation === "probe"
          ? info
          : r.operation === "credentialStatus"
            ? true
            : r.operation === "start"
              ? session
              : null,
  );
  const provider = { forwardingMutation: providerMutation } as unknown as NonNullable<
    Parameters<typeof WindowForwardingConnectDialog>[0]["provider"]
  >["client"];
  const element = () => (
    <WindowForwardingConnectDialog
      client={f.client}
      lease={{ ...lease }}
      rule={{ ...rule }}
      provider={{ client: provider, token: "original-provider-child" }}
      onClose={f.close}
      onConnected={f.done}
    />
  );
  const view = render(element());
  await screen.findByText("Trusted");
  view.rerender(element());
  expect(f.control.mock.calls.filter(([r]) => r.action === "beginInteraction")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ephemeral-provider" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(f.done).toHaveBeenCalledExactlyOnceWith(session));
  expect(f.mutation).not.toHaveBeenCalled();
  for (const [token, actualLease, r] of providerMutation.mock.calls) {
    expect(token).toBe("original-provider-child");
    expect(actualLease).toEqual(lease);
    expect(r).toMatchObject({ interaction: "origin-1" });
  }
});

it("retires a replaced provider child and ignores its late preparation instead of adopting replacement authority", async () => {
  const f = fixture(),
    old = deferred<unknown>();
  const mutation = vi.fn(
    async (token: string, _lease: unknown, r: ForwardingWindowMutation): Promise<unknown> =>
      r.operation === "prepareStart"
        ? token === "old-child"
          ? old.promise
          : structuredClone(plan)
        : r.operation === "probe"
          ? info
          : true,
  );
  const provider = { forwardingMutation: mutation } as unknown as NonNullable<
    Parameters<typeof WindowForwardingConnectDialog>[0]["provider"]
  >["client"];
  const element = (token: string) => (
    <WindowForwardingConnectDialog
      client={f.client}
      lease={lease}
      rule={rule}
      provider={{ client: provider, token }}
      onClose={f.close}
      onConnected={f.done}
    />
  );
  const view = render(element("old-child"));
  await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
  view.rerender(element("new-child"));
  await screen.findByText("Trusted");
  await act(async () => old.resolve(plan));
  expect(f.control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "origin-1" });
  expect(
    mutation.mock.calls.filter(
      ([token, , r]) => token === "old-child" && r.operation !== "prepareStart",
    ),
  ).toHaveLength(0);
  expect(f.mutation).not.toHaveBeenCalled();
});

it("retires the old provider client even with the same child string and does not reacquire on ordinary model refresh", async () => {
  const f = fixture();
  const pending = deferred<unknown>();
  const old = { forwardingMutation: vi.fn(() => pending.promise) };
  const next = {
    forwardingMutation: vi.fn(
      async (_token: string, _lease: unknown, r: ForwardingWindowMutation) =>
        r.operation === "prepareStart"
          ? structuredClone(plan)
          : r.operation === "probe"
            ? info
            : true,
    ),
  };
  type Client = NonNullable<
    Parameters<typeof WindowForwardingConnectDialog>[0]["provider"]
  >["client"];
  const element = (client: Client) => (
    <WindowForwardingConnectDialog
      client={f.client}
      lease={{ ...lease }}
      rule={{ ...rule }}
      provider={{ client, token: "same-child" }}
      onClose={f.close}
      onConnected={f.done}
    />
  );
  const view = render(element(old as unknown as Client));
  await waitFor(() => expect(old.forwardingMutation).toHaveBeenCalledOnce());
  view.rerender(element(next as unknown as Client));
  await screen.findByText("Trusted");
  view.rerender(element(next as unknown as Client));
  await act(async () => pending.resolve(plan));
  expect(f.control.mock.calls.filter(([r]) => r.action === "beginInteraction")).toHaveLength(2);
  expect(f.control).toHaveBeenCalledWith({ action: "endInteraction", lease, id: "origin-1" });
  expect(f.mutation).not.toHaveBeenCalled();
});

it("keeps late provider connection completion out of replacement callbacks and leaves the fresh prompt open", async () => {
  const f = fixture(),
    pending = deferred<unknown>();
  const mutation = vi.fn(
    async (token: string, _lease: unknown, r: ForwardingWindowMutation): Promise<unknown> =>
      r.operation === "prepareStart"
        ? structuredClone(plan)
        : r.operation === "probe"
          ? info
          : r.operation === "credentialStatus"
            ? true
            : r.operation === "start"
              ? token === "old"
                ? pending.promise
                : session
              : null,
  );
  type Client = NonNullable<
    Parameters<typeof WindowForwardingConnectDialog>[0]["provider"]
  >["client"];
  const provider = { forwardingMutation: mutation } as unknown as Client;
  const replacement = vi.fn();
  const element = (token: string, done = f.done) => (
    <WindowForwardingConnectDialog
      client={f.client}
      lease={lease}
      rule={rule}
      provider={{ client: provider, token }}
      onClose={f.close}
      onConnected={done}
    />
  );
  const view = render(element("old"));
  await screen.findByText("Trusted");
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() =>
    expect(
      mutation.mock.calls.some(([token, , r]) => token === "old" && r.operation === "start"),
    ).toBe(true),
  );
  view.rerender(element("fresh", replacement));
  await screen.findByText("Trusted");
  await act(async () => pending.resolve(session));
  expect(f.done).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  expect(f.mutation).not.toHaveBeenCalled();
});
