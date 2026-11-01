import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { PluginChatConfigDialog, type ChatConfigDraft } from "@/features/plugins/PluginChatConfig";
import type { ChatProfilePolicy } from "@/lib/plugins/pluginChat";
import { chat } from "../fixtures/pluginChat";

vi.mock("@/lib/api/ipc", () => ({
  api: { pluginPickExecutable: vi.fn(), pluginPickFolder: vi.fn() },
  isTauri: () => true,
}));

const policy = (protocol: "codex" | "claude-code" | "pi"): ChatProfilePolicy => ({
  primaryProtocols: [protocol],
  reviewerProtocols: ["openai-chat", "openai-responses", "anthropic", "gemini"],
  defaultProtocol: protocol,
});

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("independent agent configuration", () => {
  for (const protocol of ["codex", "claude-code", "pi"] as const) {
    it(`${protocol} creates only its own CLI connection and keeps API reviewers separate`, async () => {
      const save = vi.fn<(draft: ChatConfigDraft) => Promise<boolean>>().mockResolvedValue(true);
      const reviewer = chat.config!.profiles[0]!;
      render(
        <PluginChatConfigDialog
          title={protocol}
          profilePolicy={policy(protocol)}
          config={{
            ...chat.config!,
            profiles: [reviewer],
            activeProfileId: "",
            approverProfileId: reviewer.id,
          }}
          busy={false}
          error={null}
          onClose={vi.fn()}
          onSave={save}
        />,
      );
      expect(screen.getByRole("dialog", { name: `Configure ${protocol}` })).toBeTruthy();
      expect(screen.queryByLabelText("API base URL")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
      expect(screen.getByLabelText("Executable path")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "API or CLI" })).toBeNull();
      fireEvent.change(screen.getByLabelText("Executable path"), {
        target: { value: `/tools/${protocol}` },
      });
      fireEvent.click(screen.getByRole("button", { name: "Independent reviewer" }));
      expect(screen.queryByLabelText("Executable path")).toBeNull();
      expect((screen.getByLabelText("API base URL") as HTMLInputElement).value).toBe(
        reviewer.baseUrl,
      );
      fireEvent.click(screen.getByRole("button", { name: "API or CLI" }));
      expect(screen.queryByRole("option", { name: "codex" })).toBeNull();
      expect(screen.queryByRole("option", { name: "claude-code" })).toBeNull();
      expect(screen.queryByRole("option", { name: "pi" })).toBeNull();
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      const saved = save.mock.calls[0]![0];
      expect(saved.profiles[0]).toEqual(reviewer);
      expect(saved.profiles[1]).toMatchObject({ protocol, executable: `/tools/${protocol}` });
      expect(saved.activeProfileId).toBe(saved.profiles[1]!.id);
      expect(saved.approverProfileId).toBe(reviewer.id);
    });
  }
});
