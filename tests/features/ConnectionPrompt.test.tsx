import { usePanelWindows } from "@/store/panelWindows";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import "@/i18n/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionPrompt } from "@/features/connect/ConnectionPrompt";
import { connectionPromptHost, type ConnectionPromptServices } from "@/features/connect/prompt";
import type { Host, SshSession } from "@/lib/api/types";
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  raw: { credentialStatus: vi.fn(), sshCancelTest: vi.fn(), sshTestConnection: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@/lib/api/ipc", () => ({ api: mock.raw }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const host = {
  id: "h",
  name: "Target",
  host: "qa.example",
  port: 22,
  username: "qa",
  authMethod: "password" as const,
};
const session = { id: "s", hostId: "h", address: "qa@qa.example:22" } as SshSession;
function services() {
  return {
    prepare: vi.fn().mockResolvedValue({ jumpHosts: [] }),
    credentialStatus: vi.fn().mockResolvedValue(false),
    probe: vi
      .fn()
      .mockResolvedValue({ hostId: "h", fingerprint: "SHA256:reviewed", status: "known" }),
    trust: vi
      .fn()
      .mockResolvedValue({ hostId: "h", fingerprint: "SHA256:reviewed", status: "known" }),
    connect: vi.fn().mockResolvedValue(session),
    test: vi.fn(),
    cancelTest: vi.fn().mockResolvedValue(undefined),
    credential: vi.fn().mockResolvedValue(undefined),
    installKey: vi.fn().mockResolvedValue(undefined),
  } satisfies ConnectionPromptServices;
}
function noRaw() {
  expect(mock.invoke).not.toHaveBeenCalled();
  for (const fn of Object.values(mock.raw)) expect(fn).not.toHaveBeenCalled();
}
it("projects host display metadata without credential paths, source tokens or mutable settings", () => {
  const projected = connectionPromptHost({
    ...host,
    keyPath: "never-key-path",
    password: "never-password",
    source: { pluginId: "never-owner", itemId: "never-reference" },
  } as unknown as Host);
  expect(projected).toEqual({ ...host, source: true });
  expect(JSON.stringify(projected)).not.toContain("never-");
});
it("renders and submits through its supplied services only, including remembered credentials and origin-window completion", async () => {
  const backend = services(),
    done = vi.fn(),
    close = vi.fn();
  render(
    <ConnectionPrompt
      host={host}
      services={backend}
      after="background"
      onConnected={done}
      onClose={close}
    />,
  );
  await screen.findByText("Trusted");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "memory-only" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(backend.connect).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ hostId: "h", background: true, password: "memory-only" }),
  );
  expect(backend.credential).toHaveBeenCalledExactlyOnceWith("h", "memory-only");
  expect(done).toHaveBeenCalledExactlyOnceWith(session);
  noRaw();
});
it("keeps forgetting credentials in a local nested controlled confirmation and preserves failed consent", async () => {
  const backend = services();
  backend.credentialStatus.mockResolvedValue(true);
  backend.credential.mockRejectedValueOnce(new Error("keychain locked"));
  render(
    <ConnectionPrompt host={host} services={backend} onConnected={vi.fn()} onClose={vi.fn()} />,
  );
  const forget = await screen.findByRole("button", { name: "Forget" });
  fireEvent.click(forget);
  const dialogs = screen.getAllByRole("dialog"),
    confirm = dialogs.at(-1)!;
  fireEvent.click(within(confirm).getByRole("button", { name: "Forget" }));
  await waitFor(() =>
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  fireEvent.click(within(confirm).getByRole("button", { name: "Forget" }));
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
  expect(backend.credential).toHaveBeenNthCalledWith(1, "h", null);
  expect(backend.credential).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
  noRaw();
});
it("cancels an in-flight quality test through the provided backend on unmount, never raw IPC", async () => {
  const backend = services();
  backend.credentialStatus.mockResolvedValue(true);
  backend.test.mockImplementation(() => new Promise(() => {}));
  const view = render(
    <ConnectionPrompt host={host} services={backend} onConnected={vi.fn()} onClose={vi.fn()} />,
  );
  await screen.findByText("Trusted");
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(backend.test).toHaveBeenCalledOnce());
  const id = backend.test.mock.calls[0]![0];
  view.unmount();
  expect(backend.cancelTest).toHaveBeenCalledExactlyOnceWith(id);
  noRaw();
});
it("an invalidated review clears typed credentials and disables connecting without falling back to main stores", async () => {
  const backend = services();
  backend.connect.mockRejectedValueOnce(new Error("ssh.connectionChanged"));
  render(
    <ConnectionPrompt host={host} services={backend} onConnected={vi.fn()} onClose={vi.fn()} />,
  );
  await screen.findByText("Trusted");
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-target-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText(/Close and reopen this dialog/);
  expect(screen.getByLabelText("Password")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
  expect(backend.credential).not.toHaveBeenCalled();
  noRaw();
});
it("late probe replies after unmount do not start trust, connect or credential effects", async () => {
  const backend = services();
  let resolve!: (info: unknown) => void;
  backend.probe.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <ConnectionPrompt host={host} services={backend} onConnected={vi.fn()} onClose={vi.fn()} />,
  );
  view.unmount();
  await act(async () => resolve({ hostId: "h", fingerprint: "SHA256:late", status: "unknown" }));
  expect(backend.trust).not.toHaveBeenCalled();
  expect(backend.connect).not.toHaveBeenCalled();
  expect(backend.credential).not.toHaveBeenCalled();
  noRaw();
});

it("the standalone main adapter refuses satellite execution before native or credential effects", () => {
  const before = usePanelWindows.getState().windowId;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  usePanelWindows.setState({ windowId: "satellite" });
  try {
    expect(() => render(<ConnectDialog host={host as Host} onClose={vi.fn()} />)).toThrow(
      "unsupportedView",
    );
    noRaw();
  } finally {
    usePanelWindows.setState({ windowId: before });
    consoleError.mockRestore();
  }
});
it("does not re-probe or re-read credentials when window appearance refresh repeats the current language", async () => {
  const i18n = (await import("@/i18n/i18n")).default;
  const backend = services();
  render(
    <ConnectionPrompt host={host} services={backend} onClose={() => {}} onConnected={() => {}} />,
  );
  await waitFor(() => expect(backend.probe).toHaveBeenCalledOnce());
  await act(async () => {
    await i18n.changeLanguage("en-US");
  });
  await act(async () => {
    await i18n.changeLanguage("en-US");
  });
  expect(backend.probe).toHaveBeenCalledOnce();
  expect(backend.credentialStatus).toHaveBeenCalledOnce();
});
