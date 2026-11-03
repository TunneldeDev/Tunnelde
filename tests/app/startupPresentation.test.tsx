import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@/App";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  fonts: vi.fn(),
  present: vi.fn(),
  tauri: true,
  ensureWelcome: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/app/bootstrap", () => ({ bootstrap: mocks.bootstrap }));
vi.mock("@/app/startupFonts", () => ({ loadStartupFonts: mocks.fonts }));
vi.mock("@/lib/api/ipc", () => ({
  api: { mainWindowReady: mocks.present },
  isTauri: () => mocks.tauri,
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: () => <div data-testid="shell">Restored workspace</div>,
}));
vi.mock("@/features/plugins/NodeRuntimeSection", () => ({ NodeRuntimeGate: () => null }));
vi.mock("@/features/plugins/PluginPermissionGate", () => ({
  PluginPermissionGate: () => null,
  PluginRecoveryPrompt: () => null,
}));
vi.mock("@/store/workspace", () => ({
  useWorkspace: { getState: () => ({ ensureWelcome: mocks.ensureWelcome }) },
}));
vi.mock("@/store/toasts", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/errors", () => ({ translateError: String }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tauri = true;
  mocks.bootstrap.mockResolvedValue(undefined);
  mocks.fonts.mockResolvedValue(undefined);
  mocks.present.mockImplementation(async () => {
    expect(screen.getByTestId("shell")).toBeTruthy();
  });
});

describe("first window presentation", () => {
  it("waits for workspace restoration, a committed shell and selected fonts without an animation frame", async () => {
    const startup = deferred();
    const fonts = deferred();
    mocks.bootstrap.mockReturnValue(startup.promise);
    mocks.fonts.mockReturnValue(fonts.promise);
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(screen.queryByTestId("shell")).toBeNull();
    expect(mocks.fonts).not.toHaveBeenCalled();
    expect(mocks.present).not.toHaveBeenCalled();

    await act(async () => startup.resolve());
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(mocks.present).not.toHaveBeenCalled();

    await act(async () => fonts.resolve());
    expect(mocks.present).toHaveBeenCalledOnce();
    expect(frame).not.toHaveBeenCalled();
  });

  it("does not reveal a window after its frontend unmounts while fonts are loading", async () => {
    const fonts = deferred();
    mocks.fonts.mockReturnValue(fonts.promise);
    const view = render(<App />);
    await waitFor(() => expect(mocks.fonts).toHaveBeenCalled());
    view.unmount();
    await act(async () => fonts.resolve());
    expect(mocks.present).not.toHaveBeenCalled();
  });

  it("shows the fallback workspace and reports unexpected bootstrap failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.bootstrap.mockRejectedValue(new Error("unreadable workspace"));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(mocks.present).toHaveBeenCalledOnce());
    expect(mocks.ensureWelcome).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith("Error: unreadable workspace", "error");
  });

  it("still reveals the restored workspace when font preparation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.fonts.mockRejectedValue(new Error("font unavailable"));
    render(<App />);
    await waitFor(() => expect(mocks.present).toHaveBeenCalledOnce());
  });

  it("keeps browser previews independent of native presentation", async () => {
    mocks.tauri = false;
    render(<App />);
    await screen.findByTestId("shell");
    expect(mocks.fonts).not.toHaveBeenCalled();
    expect(mocks.present).not.toHaveBeenCalled();
  });
});
