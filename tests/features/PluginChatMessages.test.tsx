import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@/i18n/i18n";
import { PluginChatMessages } from "@/features/plugins/PluginChatMessages";

describe("shared assistant activity view", () => {
  it.each(["Tunnelde AI", "Codex", "Claude Code", "Pi"])(
    "%s keeps intermediate work collapsed and final text visible",
    (title) => {
      render(
        <PluginChatMessages
          title={title}
          active={false}
          messages={[
            { id: "user", role: "user", content: "List machines" },
            {
              id: "thinking",
              role: "assistant",
              content: "I will check",
              activity: [
                {
                  id: "r",
                  kind: "reasoning",
                  title: "",
                  content: "Inspect the authorized context",
                },
              ],
            },
            { id: "tool", role: "tool", name: "list_sessions", content: "development, production" },
            { id: "reply", role: "assistant", content: "Two machines are connected." },
          ]}
        />,
      );
      const activity = screen.getByText("Activity").closest("details")!;
      expect(activity.open).toBe(false);
      expect(screen.getByText("Two machines are connected.").closest("details")).toBeNull();
      fireEvent.click(screen.getByText("Activity"));
      expect(activity.open).toBe(true);
      expect(screen.getByText("list_sessions")).toBeTruthy();
    },
  );
});
