import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { ConfirmDialogHost } from "@/components/ui/overlay/ConfirmDialogHost";
import { startNativePluginUi, type NativePluginUiPrompt } from "@/lib/panels/windowPluginUi";
import { useDialogs } from "@/store/dialogs";

let stop: (() => void) | undefined;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useDialogs.getState().close();
});
afterEach(() => {
  act(() => {
    stop?.();
    stop = undefined;
    useDialogs.getState().close();
  });
});

it.each(["en-US", "zh-CN"])(
  "renders native force consent with Cancel focused in %s",
  async (locale) => {
    await i18n.changeLanguage(locale);
    const prompt: NativePluginUiPrompt = {
      id: "force",
      pluginId: "sshfs",
      method: "__mounts.forceUnmount",
      message: "Force unmount may discard pending file writes. Continue?",
    };
    const replyPluginUi = vi.fn(async () => {});
    const failure = vi.fn();
    render(<ConfirmDialogHost />);
    await act(async () => {
      stop = startNativePluginUi(
        { listPluginUi: async () => [prompt], replyPluginUi, subscribe: async () => () => {} },
        failure,
      );
    });
    const cancel = await screen.findByRole("button", { name: i18n.t("common.cancel") });
    const action = screen.getByRole("button", { name: i18n.t("mounts.forceUnmountConfirm") });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(action.className).toContain("danger");
    expect(screen.getByRole("dialog").textContent).toContain(prompt.message);
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(replyPluginUi).toHaveBeenCalledExactlyOnceWith("force", false, undefined),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(failure).not.toHaveBeenCalled();
  },
);
it("approves only after explicit destructive action and a late cleanup cannot close a replacement", async () => {
  const replyPluginUi = vi.fn(async () => {});
  render(<ConfirmDialogHost />);
  await act(async () => {
    stop = startNativePluginUi(
      {
        listPluginUi: async () => [
          { id: "force", pluginId: "sshfs", method: "__mounts.forceUnmount", message: "Force?" },
        ],
        replyPluginUi,
        subscribe: async () => () => {},
      },
      vi.fn(),
    );
  });
  const action = await screen.findByRole("button", { name: "Force unmount" });
  expect(replyPluginUi).not.toHaveBeenCalled();
  fireEvent.click(action);
  await waitFor(() =>
    expect(replyPluginUi).toHaveBeenCalledExactlyOnceWith("force", true, undefined),
  );
  act(() =>
    useDialogs
      .getState()
      .confirm({ title: "Next task", body: "Unrelated", confirmLabel: "Proceed", onConfirm() {} }),
  );
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Next task"));
});
