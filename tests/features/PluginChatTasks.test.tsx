import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { PluginChatTasks } from "@/features/plugins/PluginChatTasks";
import { PluginChatApprovalDetail } from "@/features/plugins/PluginChatApprovalDetail";
import type { ChatTask } from "@/lib/plugins/pluginChat";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
const task = (id: string, status: ChatTask["status"], extra: Partial<ChatTask> = {}): ChatTask => ({
  id,
  title: id,
  runId: id,
  status,
  output: "",
  recoverable: false,
  ...extra,
});

describe("chat task history", () => {
  it("keeps running, queued, recoverable and current failures visible while lazily collapsing past work", async () => {
    const onRecover = vi.fn();
    const tasks = [
      ...Array.from({ length: 20 }, (_, index) =>
        task(`past-${index}`, "done", { output: "large prior output" }),
      ),
      task("old-failure", "failed"),
      task("cancelled", "cancelled"),
      task("working", "running"),
      task("pending", "queued"),
      task("current", "failed"),
      task("recovery", "interrupted", { recoverable: true, runId: "captured-run" }),
    ];
    const view = render(
      <PluginChatTasks
        tasks={tasks}
        currentRunId="current"
        disabled={false}
        onRecover={onRecover}
      />,
    );
    for (const id of ["working", "pending", "current", "recovery"])
      expect(screen.getByText(id)).toBeTruthy();
    expect(screen.queryByText("past-0")).toBeNull();
    expect(screen.queryByText("large prior output")).toBeNull();
    expect(view.container.querySelectorAll(".plugin-chat__task")).toHaveLength(4);
    expect(screen.getByText("22 past tasks")).toBeTruthy();
    expect(screen.getByText("1 failed or interrupted")).toBeTruthy();
    expect(onRecover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect task" }));
    expect(onRecover).toHaveBeenLastCalledWith(tasks.at(-1), "inspect");
    fireEvent.click(screen.getByRole("button", { name: "Continue task" }));
    expect(onRecover).toHaveBeenLastCalledWith(tasks.at(-1), "resume");
    fireEvent.click(screen.getByText("22 past tasks"));
    await waitFor(() => expect(screen.getByText("past-0")).toBeTruthy());
    expect(view.container.querySelectorAll(".plugin-chat__task")).toHaveLength(26);
    fireEvent.click(screen.getByText("22 past tasks"));
    await waitFor(() => expect(screen.queryByText("past-0")).toBeNull());
  });

  it("retains explicit expansion on updates and resets it for another conversation", async () => {
    const first = [task("first", "done")];
    const view = render(<PluginChatTasks key="session-1" tasks={first} disabled />);
    fireEvent.click(screen.getByText("1 past task"));
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());
    view.rerender(
      <PluginChatTasks key="session-1" tasks={[...first, task("second", "done")]} disabled />,
    );
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getByText("2 past tasks").closest("details")?.open).toBe(true);
    view.rerender(<PluginChatTasks key="session-2" tasks={first} disabled />);
    await act(async () => {});
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("1 past task").closest("details")?.open).toBe(false);
  });

  it("does not hide an older plugin's unidentified failures or allow recovery during another action", () => {
    const recover = vi.fn();
    render(
      <PluginChatTasks
        tasks={[task("legacy failure", "failed", { runId: undefined, recoverable: true })]}
        currentRunId="latest"
        disabled
        onRecover={recover}
      />,
    );
    expect(screen.getByText("legacy failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue task" }));
    expect(recover).not.toHaveBeenCalled();
    expect(screen.queryByText(/past task/)).toBeNull();
  });

  it("preserves original output and displays inspection once for the actionable task", () => {
    const view = render(
      <PluginChatTasks
        tasks={[
          task("failed", "failed", {
            output: "Original output",
            inspection: "Status: failed\nExit code: 1",
          }),
        ]}
        currentRunId="failed"
        disabled
      />,
    );
    expect(screen.getByText("Original output").closest("details")?.open).toBe(false);
    expect(screen.getByText(/Exit code: 1/).closest("details")?.open).toBe(true);
    view.rerender(
      <PluginChatTasks
        tasks={[
          task("failed", "failed", { output: "Status: failed", inspection: "Status: failed" }),
        ]}
        currentRunId="failed"
        disabled
      />,
    );
    expect(screen.getAllByText("Status: failed")).toHaveLength(1);
  });
});

describe("tool approval detail presentation", () => {
  it("formats single and double encoded protocol objects without changing any fields", () => {
    const input = {
      tool: "write",
      input: {
        path: "项目/config.json",
        content: '{"literal":"\\n"}',
        note: "<script>untrusted()</script>",
      },
    };
    const raw = JSON.stringify(input);
    const view = render(<PluginChatApprovalDetail detail={JSON.stringify(raw)} />);
    expect(view.container.querySelector("pre")?.textContent).toBe(JSON.stringify(input, null, 2));
    expect(view.container.querySelector("script")).toBeNull();
    view.rerender(<PluginChatApprovalDetail detail={raw} />);
    expect(view.container.querySelector("pre")?.textContent).toBe(JSON.stringify(input, null, 2));
  });

  it("preserves multiline messages, primitive values and incomplete JSON rather than dropping diagnostics", () => {
    const view = render(<PluginChatApprovalDetail detail={"Command requested\nCheck this path"} />);
    expect(view.container.textContent).toBe("Command requested\nCheck this path");
    for (const detail of ['{"truncated":', "null", "false", "42"]) {
      view.rerender(<PluginChatApprovalDetail detail={detail} />);
      expect(view.container.textContent).toBe(detail);
    }
    view.rerender(
      <PluginChatApprovalDetail detail={JSON.stringify("Plain message\nwith newline")} />,
    );
    expect(view.container.textContent).toBe("Plain message\nwith newline");
  });
});
