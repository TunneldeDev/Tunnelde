import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { EditorConflictDialog } from "@/features/editor/EditorConflictDialog";
import { api } from "@/lib/api/ipc";
import { useEditors } from "@/store/editors";

beforeEach(async () => {
  for (const key of Object.keys(useEditors.getState().entries)) useEditors.getState().discard(key);
  vi.spyOn(api, "sftpReadText").mockResolvedValue({ content: "original", size: 8 });
  await useEditors.getState().open("review", "session", "/note.txt");
  useEditors.getState().change("review", "unsaved draft");
  vi.mocked(api.sftpReadText).mockResolvedValue({ content: "external update", size: 15 });
  vi.spyOn(api, "sftpWriteText").mockResolvedValue(undefined);
});

it("compares the actual disk text and retains the draft when dismissed", async () => {
  const onClose = vi.fn();
  render(<EditorConflictDialog tabId="review" onClose={onClose} />);
  await screen.findByDisplayValue("external update");
  expect(screen.getByDisplayValue("unsaved draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(useEditors.getState().entries.review?.content).toBe("unsaved draft");
  expect(api.sftpWriteText).not.toHaveBeenCalled();
});

it("only replaces the disk version the user actually reviewed", async () => {
  const onClose = vi.fn();
  render(<EditorConflictDialog tabId="review" onClose={onClose} />);
  await screen.findByDisplayValue("external update");
  fireEvent.click(screen.getByRole("button", { name: "Replace disk version" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.sftpWriteText).toHaveBeenCalledWith(
    "session",
    "/note.txt",
    "unsaved draft",
    "external update",
  );
});

it("keeps replacement disabled when the latest disk version could not be read", async () => {
  vi.mocked(api.sftpReadText).mockRejectedValue({ code: "ssh", message: "sftp.reconnectRequired" });
  render(<EditorConflictDialog tabId="review" onClose={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Replace disk version" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Reload from disk" })).toHaveProperty("disabled", true);
  expect(useEditors.getState().entries.review?.content).toBe("unsaved draft");
});
