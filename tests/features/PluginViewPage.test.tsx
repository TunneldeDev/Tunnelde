import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, copyMock, nativeMock, authorizeMock } = vi.hoisted(() => ({
  copyMock: vi.fn(),
  nativeMock: vi.fn(() => false),
  authorizeMock: vi.fn(),
  apiMock: {
    pluginRenderView: vi.fn(),
    pluginRun: vi.fn(),
  },
}));

vi.mock("@/lib/api/ipc", () => ({ api: apiMock, isTauri: nativeMock }));
vi.mock("@/store/pluginSecurity", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  authorizePluginAction: authorizeMock,
}));
vi.mock("@/lib/session/clipboard", () => ({ copyText: copyMock }));
vi.mock("@/features/plugins/PluginChat", () => ({
  PluginChat: ({ visible }: { visible: boolean }) => (
    <div data-testid="plugin-chat" data-visible={visible} />
  ),
}));

import "@/i18n/i18n";
import { PluginViewPage } from "@/features/plugins/PluginViewPage";
beforeEach(() => {
  nativeMock.mockReturnValue(false);
  authorizeMock.mockReset().mockResolvedValue(true);
});

describe("PluginViewPage", () => {
  it("passes visibility to mounted chats without reloading their view", async () => {
    apiMock.pluginRenderView.mockClear().mockResolvedValue({
      blocks: [{ type: "chat", id: "chat", commands: { send: "send", stop: "stop" } }],
    });
    const view = render(<PluginViewPage pluginId="ai" viewId="chat" visible={false} />);
    const chat = await screen.findByTestId("plugin-chat");
    expect(chat.dataset.visible).toBe("false");
    view.rerender(<PluginViewPage pluginId="ai" viewId="chat" visible />);
    expect(chat.dataset.visible).toBe("true");
    expect(apiMock.pluginRenderView).toHaveBeenCalledOnce();
  });

  it("omits the redundant refresh header for chat-only views but keeps it for mixed tools", async () => {
    const chat = { type: "chat", id: "chat", commands: { send: "send", stop: "stop" } };
    apiMock.pluginRenderView.mockResolvedValueOnce({ title: "AI", blocks: [chat] });
    const { container, rerender } = render(<PluginViewPage pluginId="ai" viewId="chat" embedded />);
    expect(await screen.findByTestId("plugin-chat")).toBeTruthy();
    expect(container.querySelector(".plugin-view__head")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    apiMock.pluginRenderView.mockResolvedValueOnce({
      blocks: [chat, { type: "text", text: "Tool status" }],
    });
    rerender(<PluginViewPage pluginId="ai" viewId="mixed" embedded />);
    expect(await screen.findByText("Tool status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("keeps password form fields masked and sends them only after explicit submission", async () => {
    apiMock.pluginRenderView.mockResolvedValue({
      blocks: [
        {
          type: "form",
          id: "credentials",
          fields: [{ id: "token", type: "password", label: "API token", value: "" }],
          actions: [{ id: "save", label: "Save token", command: "configure" }],
        },
      ],
    });
    apiMock.pluginRun.mockClear().mockResolvedValue({ text: "Saved" });
    render(<PluginViewPage pluginId="example" viewId="config" />);
    const token = (await screen.findByLabelText("API token")) as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("off");
    fireEvent.change(token, { target: { value: "example-private-token" } });
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await waitFor(() =>
      expect(apiMock.pluginRun).toHaveBeenCalledWith(
        "example",
        "configure",
        expect.objectContaining({ token: "example-private-token" }),
      ),
    );
  });

  it("renders heading, key/value and table blocks", async () => {
    apiMock.pluginRenderView.mockResolvedValue({
      title: "Hello plugin",
      blocks: [
        { type: "heading", text: "Example view" },
        { type: "text", text: "Rendered by the host" },
        { type: "kv", items: [{ label: "Plugin", value: "hello" }] },
        { type: "table", columns: ["Metric", "Value"], rows: [["cpu", "0.1"]] },
      ],
    });

    render(<PluginViewPage pluginId="hello" viewId="hello" />);

    expect(await screen.findByText("Example view")).toBeTruthy();
    expect(screen.getByText("Hello plugin")).toBeTruthy();
    expect(screen.getByText("Rendered by the host")).toBeTruthy();
    expect(screen.getByText("Plugin")).toBeTruthy();
    expect(screen.getAllByText("hello").length).toBeGreaterThan(0);
    expect(screen.getByText("cpu")).toBeTruthy();
    expect(screen.getByText("0.1")).toBeTruthy();
  });

  it("shows the empty state for an empty payload", async () => {
    apiMock.pluginRenderView.mockResolvedValue({ blocks: [] });
    render(<PluginViewPage pluginId="hello" viewId="empty" />);
    expect(await screen.findByText("No content")).toBeTruthy();
  });

  it("clears the previous view and ignores its late refresh after switching plugins", async () => {
    let finishRefresh!: (value: unknown) => void;
    let finishNewView!: (value: unknown) => void;
    apiMock.pluginRenderView
      .mockResolvedValueOnce({
        title: "First plugin",
        blocks: [{ type: "text", text: "Old content" }],
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNewView = resolve;
          }),
      );
    const { rerender } = render(<PluginViewPage pluginId="first" viewId="main" />);
    expect(await screen.findByText("Old content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    rerender(<PluginViewPage pluginId="second" viewId="main" />);
    expect(screen.queryByText("Old content")).toBeNull();
    expect(screen.queryByText("First plugin")).toBeNull();
    await act(async () => finishRefresh({ title: "Stale response", blocks: [] }));
    expect(screen.queryByText("Stale response")).toBeNull();
    await act(async () => finishNewView({ title: "Second plugin", blocks: [] }));
    expect(screen.getByText("Second plugin")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("allows retry after a failed load and clears the error on success", async () => {
    apiMock.pluginRenderView.mockRejectedValueOnce(new Error("temporarily unavailable"));
    render(<PluginViewPage pluginId="hello" viewId="main" />);
    expect(await screen.findByText("temporarily unavailable")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    apiMock.pluginRenderView.mockResolvedValueOnce({ title: "Recovered", blocks: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Recovered")).toBeTruthy();
    expect(screen.queryByText("temporarily unavailable")).toBeNull();
  });

  const interactive = {
    title: "JSON Formatter",
    blocks: [
      {
        type: "form",
        id: "json",
        fields: [
          { id: "source", type: "textarea", label: "JSON input", value: "{}" },
          {
            id: "indent",
            type: "select",
            label: "Indent",
            value: "2",
            options: [
              { value: "2", label: "2 spaces" },
              { value: "4", label: "4 spaces" },
            ],
          },
        ],
        actions: [
          { id: "pretty", label: "Format", command: "pretty" },
          { id: "minify", label: "Minify", command: "minify" },
        ],
      },
    ],
  };

  it("requests permission only for explicit native actions and does not run when denied", async () => {
    nativeMock.mockReturnValue(true);
    authorizeMock.mockResolvedValue(false);
    apiMock.pluginRenderView.mockClear().mockResolvedValue(interactive);
    apiMock.pluginRun.mockClear();
    render(<PluginViewPage pluginId="json-formatter" viewId="main" />);
    await screen.findByLabelText("JSON input");
    expect(authorizeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    await waitFor(() => expect(authorizeMock).toHaveBeenCalledWith("json-formatter"));
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Format" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(apiMock.pluginRenderView).toHaveBeenCalledOnce();
    expect(authorizeMock).toHaveBeenCalledTimes(2);
  });

  it("runs host-rendered fields and copies results only on explicit request", async () => {
    apiMock.pluginRenderView.mockResolvedValue(interactive);
    apiMock.pluginRun.mockResolvedValue({ text: '{\n  "a": 1\n}' });
    copyMock.mockClear();
    render(<PluginViewPage pluginId="json-formatter" viewId="main" />);
    const field = await screen.findByLabelText("JSON input");
    fireEvent.change(field, { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Indent" }));
    fireEvent.click(screen.getByRole("option", { name: "4 spaces" }));
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    await waitFor(() =>
      expect(apiMock.pluginRun).toHaveBeenLastCalledWith("json-formatter", "pretty", {
        source: '{"a":1}',
        indent: "4",
        _locale: expect.stringMatching(/^en/),
      }),
    );
    const output = await screen.findByLabelText("Result");
    expect((output as HTMLTextAreaElement).value).toBe('{\n  "a": 1\n}');
    expect(copyMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    expect(copyMock).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it("does not execute a command if its view closes while permission approval is pending", async () => {
    let approve!: (value: boolean) => void;
    nativeMock.mockReturnValue(true);
    authorizeMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    apiMock.pluginRenderView.mockResolvedValue(interactive);
    apiMock.pluginRun.mockClear();
    const view = render(<PluginViewPage pluginId="first" viewId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Format" }));
    view.rerender(<PluginViewPage pluginId="second" viewId="main" />);
    await screen.findByRole("button", { name: "Format" });
    await act(async () => approve(true));
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
  });

  it("retains drafts and results while hidden or refreshed and blocks concurrent runs", async () => {
    let finish!: (value: unknown) => void;
    apiMock.pluginRenderView.mockResolvedValue(interactive);
    apiMock.pluginRun.mockClear().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(
      <div hidden={false}>
        <PluginViewPage pluginId="json-formatter" viewId="main" />
      </div>,
    );
    fireEvent.change(await screen.findByLabelText("JSON input"), { target: { value: "[1,2]" } });
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect((screen.getByRole("button", { name: "Minify" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Minify" }));
    expect(apiMock.pluginRun).toHaveBeenCalledTimes(1);
    await act(async () => finish({ text: "[\n  1,\n  2\n]" }));
    rerender(
      <div hidden>
        <PluginViewPage pluginId="json-formatter" viewId="main" />
      </div>,
    );
    rerender(
      <div hidden={false}>
        <PluginViewPage pluginId="json-formatter" viewId="main" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect((screen.getByLabelText("JSON input") as HTMLTextAreaElement).value).toBe("[1,2]");
    expect((screen.getByLabelText("Result") as HTMLTextAreaElement).value).toBe("[\n  1,\n  2\n]");
  });

  it("does not place a late command result in another plugin's view", async () => {
    let finish!: (value: unknown) => void;
    apiMock.pluginRenderView.mockResolvedValue(interactive);
    apiMock.pluginRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<PluginViewPage pluginId="first" viewId="main" />);
    fireEvent.click(await screen.findByRole("button", { name: "Format" }));
    rerender(<PluginViewPage pluginId="second" viewId="main" />);
    await screen.findByRole("button", { name: "Format" });
    await act(async () => finish({ text: "Stale command result" }));
    expect(screen.queryByDisplayValue("Stale command result")).toBeNull();
  });

  it("rejects oversized UTF-8 input before invoking the plugin", async () => {
    apiMock.pluginRenderView.mockResolvedValue(interactive);
    apiMock.pluginRun.mockClear();
    render(<PluginViewPage pluginId="json-formatter" viewId="main" />);
    fireEvent.change(await screen.findByLabelText("JSON input"), {
      target: { value: "中".repeat(90000) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(apiMock.pluginRun).not.toHaveBeenCalled();
  });

  it("recovers from a command failure without losing the draft", async () => {
    apiMock.pluginRenderView.mockResolvedValue(interactive);
    apiMock.pluginRun.mockRejectedValueOnce(new Error("Plugin stopped"));
    render(<PluginViewPage pluginId="json-formatter" viewId="main" />);
    fireEvent.change(await screen.findByLabelText("JSON input"), { target: { value: "[true]" } });
    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Plugin stopped");
    expect((screen.getByLabelText("JSON input") as HTMLTextAreaElement).value).toBe("[true]");
    apiMock.pluginRun.mockResolvedValueOnce({ text: "[true]" });
    fireEvent.click(screen.getByRole("button", { name: "Minify" }));
    expect(await screen.findByLabelText("Result")).toHaveProperty("value", "[true]");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear result" }));
    expect(screen.queryByLabelText("Result")).toBeNull();
    expect((screen.getByLabelText("JSON input") as HTMLTextAreaElement).value).toBe("[true]");
  });
});
