import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactI18next from "react-i18next";

const mock = vi.hoisted(() => ({
  api: {
    nodeDetect: vi.fn(),
    nodePick: vi.fn(),
    nodeSetPath: vi.fn(),
    nodeInstall: vi.fn(),
    downloadCancel: vi.fn(),
    nodeAllowSystem: vi.fn(),
  },
  listen: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({
  api: mock.api,
  events: { onPluginDownload: mock.listen },
  isTauri: () => true,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api/errors", () => ({
  translateError: (error: { message: string }) => error.message,
}));

import {
  NodeRuntimeGate,
  NodeRuntimeSection,
  ensureNodeRuntime,
} from "@/features/plugins/NodeRuntimeSection";
import { useDialogs } from "@/store/dialogs";
import { usePluginSecurity } from "@/store/pluginSecurity";

const missing = {
  path: "/system/node",
  version: null,
  source: "path",
  compatible: false,
  minimumMajor: 22,
  issue: "node.consentRequired",
};
const ready = {
  path: "/private/node",
  version: "24.9.0",
  source: "managed",
  compatible: true,
  minimumMajor: 22,
  issue: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function section() {
  const view = render(<NodeRuntimeSection />);
  if (
    !(screen.getByRole("button", { name: "plugins.node.recheck" }) as HTMLButtonElement).disabled
  ) {
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.recheck" }));
  }
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "plugins.node.recheck" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  return view;
}
async function confirm() {
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind === "confirm")
    await act(async () => {
      await dialog.onConfirm();
    });
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.api.nodeDetect.mockResolvedValue(missing);
  mock.api.nodePick.mockResolvedValue(null);
  mock.api.nodeSetPath.mockResolvedValue(ready);
  mock.api.nodeAllowSystem.mockResolvedValue({ ...ready, source: "path" });
  mock.api.downloadCancel.mockResolvedValue(true);
  mock.listen.mockResolvedValue(vi.fn());
  useDialogs.getState().close();
  usePluginSecurity.setState({ ...usePluginSecurity.getInitialState() });
});

describe("Node runtime setup", () => {
  it("cancels an individual wait without closing setup needed by another plugin", async () => {
    render(<NodeRuntimeGate />);
    const controller = new AbortController();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = ensureNodeRuntime(controller.signal);
      second = ensureNodeRuntime();
    });
    await screen.findByRole("dialog");
    act(() => controller.abort());
    expect(await first).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(await second).toBe(false);
  });

  it("closes setup on last cancellation and ignores its late detection", async () => {
    render(<NodeRuntimeGate />);
    const old = deferred<typeof missing | typeof ready>();
    mock.api.nodeDetect.mockReturnValueOnce(old.promise);
    const controller = new AbortController();
    const first = ensureNodeRuntime(controller.signal);
    controller.abort();
    expect(await first).toBe(false);
    const second = ensureNodeRuntime();
    await screen.findByRole("dialog");
    await act(async () => old.resolve(ready));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(await second).toBe(false);
  });

  it("does not detect Node for an already cancelled caller", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await ensureNodeRuntime(controller.signal)).toBe(false);
    expect(mock.api.nodeDetect).not.toHaveBeenCalled();
  });
  it("does not check or open first-use setup while restricted", async () => {
    usePluginSecurity.setState({
      state: { ...usePluginSecurity.getState().state, restricted: true },
    });
    render(<NodeRuntimeGate />);
    await expect(ensureNodeRuntime()).resolves.toBe(false);
    expect(mock.api.nodeDetect).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a cancelled detection response instead of resolving a newer setup request", async () => {
    const stale = deferred<typeof missing>();
    const current = deferred<typeof ready>();
    mock.api.nodeDetect.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    render(<NodeRuntimeGate />);
    let first!: Promise<boolean>;
    act(() => {
      first = ensureNodeRuntime();
      usePluginSecurity.setState({
        state: { ...usePluginSecurity.getState().state, restricted: true },
      });
    });
    await expect(first).resolves.toBe(false);
    act(() =>
      usePluginSecurity.setState({
        state: { ...usePluginSecurity.getState().state, restricted: false },
      }),
    );
    const second = ensureNodeRuntime();
    const finished = vi.fn();
    void second.then(finished);
    await act(async () => stale.resolve(missing));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(finished).not.toHaveBeenCalled();
    await act(async () => current.resolve(ready));
    await expect(second).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels pending first-use setup when restricted mode is enabled", async () => {
    render(<NodeRuntimeGate />);
    let request!: Promise<boolean>;
    await act(async () => {
      request = ensureNodeRuntime();
    });
    await screen.findByRole("dialog");
    act(() =>
      usePluginSecurity.setState({
        state: { ...usePluginSecurity.getState().state, restricted: true },
      }),
    );
    await expect(request).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mock.api.nodeAllowSystem).not.toHaveBeenCalled();
    expect(mock.api.nodeInstall).not.toHaveBeenCalled();
  });
  it("does not authorize or install an existing runtime until explicitly confirmed", async () => {
    await section();
    expect(mock.api.nodeAllowSystem).not.toHaveBeenCalled();
    expect(mock.api.nodeInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.useDetected" }));
    expect(mock.api.nodeAllowSystem).not.toHaveBeenCalled();
    await confirm();
    expect(mock.api.nodeAllowSystem).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.revokeSystem" }));
    await waitFor(() => expect(mock.api.nodeAllowSystem).toHaveBeenLastCalledWith(false));
  });

  it("uses the executable picker and leaves selection unchanged on cancel", async () => {
    await section();
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.choose" }));
    await waitFor(() => expect(mock.api.nodePick).toHaveBeenCalledOnce());
    expect(mock.api.nodeSetPath).not.toHaveBeenCalled();
    mock.api.nodePick.mockResolvedValue("/chosen/node");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "plugins.node.choose" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.choose" }));
    await waitFor(() => expect(mock.api.nodeSetPath).toHaveBeenCalledWith("/chosen/node"));
    await screen.findByText("/private/node");
  });

  it("registers progress before starting installation and supports cancellation across navigation", async () => {
    const pending = deferred<typeof ready>();
    mock.api.nodeInstall.mockReturnValue(pending.promise);
    const view = await section();
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.install" }));
    expect(mock.api.nodeInstall).not.toHaveBeenCalled();
    const dialog = useDialogs.getState().dialog;
    let installing: Promise<void>;
    await act(async () => {
      if (dialog.kind === "confirm") {
        const result = dialog.onConfirm();
        expect(result).toBeUndefined(); // Close confirmation so progress/cancel stay reachable.
        installing = Promise.resolve(result);
      }
      await Promise.resolve();
    });
    await waitFor(() => expect(mock.api.nodeInstall).toHaveBeenCalledOnce());
    expect(mock.listen.mock.invocationCallOrder[0]!).toBeLessThan(
      mock.api.nodeInstall.mock.invocationCallOrder[0]!,
    );
    const taskId = mock.api.nodeInstall.mock.calls[0]![0];
    act(() =>
      mock.listen.mock.calls[0]![0]({ taskId, phase: "downloading", received: 40, total: 100 }),
    );
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(40);
    view.unmount();
    render(<NodeRuntimeSection />);
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(40);
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.cancel" }));
    await waitFor(() => expect(mock.api.downloadCancel).toHaveBeenCalledWith(taskId));
    await act(async () => {
      pending.reject({ message: "market.cancelled" });
      await installing!;
    });
    expect(screen.getByRole("alert").textContent).toBe("market.cancelled");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("can cancel while event registration is pending without starting a download", async () => {
    const subscription = deferred<() => void>();
    mock.listen.mockReturnValueOnce(subscription.promise);
    await section();
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.install" }));
    const dialog = useDialogs.getState().dialog;
    let installing: Promise<void>;
    await act(async () => {
      if (dialog.kind === "confirm") installing = Promise.resolve(dialog.onConfirm());
    });
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.cancel" }));
    await act(async () => {
      subscription.resolve(vi.fn());
      await installing!;
    });
    expect(mock.api.nodeInstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("opens first-use setup and resumes only after a compatible manual selection", async () => {
    render(<NodeRuntimeGate />);
    let result!: Promise<boolean>;
    await act(async () => {
      result = ensureNodeRuntime();
    });
    await screen.findByRole("dialog");
    mock.api.nodePick.mockResolvedValue("/chosen/node");
    fireEvent.click(screen.getByRole("button", { name: "plugins.node.choose" }));
    await act(async () => {
      await expect(result).resolves.toBe(true);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shares first-use setup and returns false when the user closes it", async () => {
    render(<NodeRuntimeGate />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = ensureNodeRuntime();
      second = ensureNodeRuntime();
    });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("continues immediately when an approved runtime is already compatible", async () => {
    mock.api.nodeDetect.mockResolvedValue(ready);
    await expect(ensureNodeRuntime()).resolves.toBe(true);
  });
});
