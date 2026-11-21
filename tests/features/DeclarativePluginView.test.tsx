import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { normalizeBlocks } from "@/lib/plugins/pluginView";
import {
  DeclarativePluginView,
  type DeclarativeViewServices,
} from "@/features/plugins/DeclarativePluginView";
import type { DeclarativePluginView as Model } from "@/lib/plugins/views/declarative";
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Renderer imported native execution owner");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Renderer imported singleton activation owner");
});
vi.mock("@/store/pluginSecurity", () => {
  throw new Error("Renderer imported consent owner");
});
vi.mock("@/lib/session/clipboard", () => {
  throw new Error("Renderer imported clipboard owner");
});
vi.mock("@/lib/session/viewState", () => {
  throw new Error("Renderer imported main session draft owner");
});
function fixture() {
  const drafts = new Map<string, unknown>();
  const run = vi.fn().mockResolvedValue({ text: "Result from owner", title: "", error: false });
  const busy = vi.fn(),
    copy = vi.fn(),
    refresh = vi.fn(),
    failure = vi.fn();
  const domain = vi.fn((block: Model["blocks"][number]) => <span>{`Domain: ${block.type}`}</span>);
  const services: DeclarativeViewServices = {
    run,
    useSecretState<T>(
      key: string,
      initial: T | (() => T),
      _validate: (value: unknown) => value is T,
    ) {
      const [value, update] = useState<T>(() =>
        drafts.has(key)
          ? (drafts.get(key) as T)
          : typeof initial === "function"
            ? (initial as () => T)()
            : initial,
      );
      drafts.set(key, value);
      return [value, update];
    },
    useBusyGuard: busy,
    useViewState<T>(key: string, initial: T | (() => T)) {
      const [value, update] = useState<T>(() =>
        drafts.has(key)
          ? (drafts.get(key) as T)
          : typeof initial === "function"
            ? (initial as () => T)()
            : initial,
      );
      drafts.set(key, value);
      return [value, update];
    },
  };
  const view: Model = {
    revision: "incarnation:1",
    title: "Shared renderer",
    blocks: [
      { type: "heading", text: "Heading" },
      { type: "text", text: "Body text" },
      { type: "kv", items: [{ label: "Key", value: "Value" }] },
      { type: "table", columns: ["Column"], rows: [["Cell"]] },
      { type: "mounts" },
      { type: "sharedMounts" },
      {
        type: "form",
        id: "tool",
        fields: [
          {
            id: "secret",
            type: "password",
            label: "Secret",
            value: "",
            placeholder: "",
            options: [],
          },
        ],
        actions: [{ id: "save", label: "Save", command: "not-sent-to-owner" }],
      },
    ],
  };
  const element = () => (
    <DeclarativePluginView
      pluginId="plugin"
      viewId="main"
      view={view}
      loading={false}
      error={null}
      onRefresh={refresh}
      services={services}
      reportFailure={failure}
      copyResult={copy}
      renderDomainBlock={domain}
      errorAction={<span>Consent owner slot</span>}
    />
  );
  return { run, busy, copy, refresh, domain, failure, element, view };
}
describe("declarative renderer effect boundary", () => {
  it("uses all block types and explicit owner slots without loading main-window effects", () => {
    const f = fixture();
    f.view.blocks.push(
      ...normalizeBlocks([{ type: "chat", id: "chat", commands: { send: "send", stop: "stop" } }]),
    );
    render(f.element());
    for (const text of [
      "Heading",
      "Body text",
      "Key",
      "Value",
      "Column",
      "Cell",
      "Domain: mounts",
      "Domain: sharedMounts",
      "Domain: chat",
    ])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByLabelText("Secret")).toHaveProperty("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("retains injected drafts/results across remount and forwards IDs rather than command strings", async () => {
    const f = fixture();
    const first = render(f.element());
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "private-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByLabelText("Result");
    expect(f.run).toHaveBeenCalledWith(
      {
        revision: "incarnation:1",
        formId: "tool",
        actionId: "save",
        values: { secret: "private-draft" },
        locale: "en-US",
      },
      expect.any(AbortSignal),
    );
    first.unmount();
    render(f.element());
    expect(screen.getByLabelText("Secret")).toHaveProperty("value", "private-draft");
    expect(screen.getByLabelText("Result")).toHaveProperty("value", "Result from owner");
    expect(f.run).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    expect(f.copy).toHaveBeenCalledExactlyOnceWith("Result from owner");
  });
  it("keeps drafts when owner actions fail and cancels view waits on unmount", async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error("Owner rejected"));
    const page = render(f.element());
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "keep" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Owner rejected");
    expect(screen.getByText("Consent owner slot")).toBeTruthy();
    expect(screen.getByLabelText("Secret")).toHaveProperty("value", "keep");
    let finish!: (value: unknown) => void;
    f.run.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    const signal = f.run.mock.calls[1]![1] as AbortSignal;
    page.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ text: "late", title: "", error: false }));
    render(f.element());
    expect(screen.queryByDisplayValue("late")).toBeNull();
  });
});
