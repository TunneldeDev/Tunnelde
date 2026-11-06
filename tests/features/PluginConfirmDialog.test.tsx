import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { DialogHost } from "@/features/dialogs/DialogHost";
import { useDialogs } from "@/store/dialogs";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useDialogs.getState().close();
});

describe("plugin tool confirmation", () => {
  it("focuses the confirmation action for destructive prompts", async () => {
    const confirm = vi.fn();
    useDialogs.getState().confirm({
      title: "Delete item",
      body: "Delete this item?",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: confirm,
    });
    render(<DialogHost />);
    const action = screen.getByRole("button", { name: "Delete" });
    expect(document.activeElement).toBe(action);
    fireEvent.click(action);
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  });

  it("renders complete long parameters in a keyboard-scrollable monospace preview", async () => {
    const body = `write configuration\n${"    preserve whitespace and code\n".repeat(5000)}`;
    const confirm = vi.fn();
    useDialogs.getState().confirm({
      title: "Plugin action",
      body,
      confirmLabel: "Allow once",
      preformatted: true,
      onConfirm: confirm,
    });
    render(<DialogHost />);
    const preview = screen.getByRole("dialog").querySelector("pre")!;
    expect(preview.textContent).toBe(body);
    expect(preview.tabIndex).toBe(0);
    expect(preview.style.whiteSpace).toBe("pre-wrap");
    expect(preview.style.fontFamily).toBe("var(--td-mono)");
    expect(preview.style.overflow).toBe("auto");
    expect(preview.style.maxHeight).toBe("55vh");
    expect(confirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(useDialogs.getState().dialog.kind).toBe("none"));
    expect(confirm).toHaveBeenCalledOnce();
  });
});
