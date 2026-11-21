import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createSettingsControlDrafts,
  isSettingsControlDrafts,
} from "@/features/settings/window/drafts";
import {
  SettingsDraftScope,
  useSettingsControlState,
  useSettingsSecretState,
} from "@/features/settings/window/SettingsDraftScope";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { useWindowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
function Controls() {
  const [value, set] = useSettingsControlState(
    "configuration:插件/" + "f".repeat(200) + ":draft",
    "",
  );
  const [password, setPassword] = useSettingsSecretState("network:password", "");
  return (
    <>
      <input aria-label="Draft" value={value} onChange={(e) => set(e.target.value)} />
      <input
        aria-label="Private draft"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </>
  );
}
function fixture(initial?: unknown) {
  const controller = createPanelViewState(initial);
  const record: WindowViewRecord = {
    key: "view",
    panelId: "settings-view:test",
    controller,
    staged: false,
    lease: { panelId: "settings-view:test", windowId: "main", generation: 1 },
  };
  useWindowViews.setState({ entries: new Map([[record.panelId, record]]) });
  const control = vi.fn(async (request: { action: string }): Promise<string | null> =>
    request.action === "readSettingsPassword" ? "host-secret" : null,
  );
  const client = { control } as unknown as PanelWindowClient;
  const mount = () =>
    render(
      <StrictMode>
        <PanelViewStateScope controller={controller}>
          <SettingsDraftScope client={client} record={record}>
            <Controls />
          </SettingsDraftScope>
        </PanelViewStateScope>
      </StrictMode>,
    );
  return { controller, record, control, mount };
}
describe("settings draft handoff binding", () => {
  it("retains more than 256 arbitrary plugin keys without exhausting controller fields", () => {
    const state = createSettingsControlDrafts();
    for (let i = 0; i < 300; i++)
      state.write(`configuration:插件/${i}/${"f".repeat(200)}:draft`, { value: `draft-${i}` });
    const saved = state.capture();
    expect(saved.entries).toHaveLength(300);
    const restored = createSettingsControlDrafts(saved);
    expect(restored.read(`configuration:插件/299/${"f".repeat(200)}:draft`, null)).toEqual({
      value: "draft-299",
    });
    expect(() => state.write("network:password", "no")).toThrow();
    expect(isSettingsControlDrafts({ version: 1, entries: [["network:password", "no"]] })).toBe(
      false,
    );
    expect(
      isSettingsControlDrafts({
        version: 1,
        entries: [
          ["a", 1],
          ["a", 2],
        ],
      }),
    ).toBe(false);
  });
  it("rejects unrepresentable/oversized drafts rather than truncating them", () => {
    const state = createSettingsControlDrafts();
    state.write("invalid", new Date());
    expect(() => state.capture()).toThrow("panel.viewState.invalid");
    const large = createSettingsControlDrafts();
    large.write("large", "x".repeat(1024 * 1024));
    expect(() => large.capture()).toThrow("panel.viewState.tooLarge");
  });
  it("survives StrictMode and flushes credentials outside the serialized capsule before a move", async () => {
    const owner = fixture();
    owner.mount();
    await screen.findByRole("textbox", { name: "Draft" });
    fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), {
      target: { value: "unsaved" },
    });
    fireEvent.change(screen.getByLabelText("Private draft"), {
      target: { value: "new-private-secret" },
    });
    let captured: unknown;
    await act(async () => {
      captured = await owner.controller.captureAsync(undefined, { intent: "move" });
    });
    expect(JSON.stringify(captured)).toContain("unsaved");
    expect(JSON.stringify(captured)).not.toContain("new-private-secret");
    expect(JSON.stringify(captured)).not.toContain("host-secret");
    expect(owner.control).toHaveBeenLastCalledWith({
      action: "writeSettingsPassword",
      lease: owner.record.lease,
      value: "new-private-secret",
    });
  });
  it("does not acknowledge a capture when the private flush fails", async () => {
    const owner = fixture();
    owner.mount();
    await screen.findByRole("textbox", { name: "Draft" });
    owner.control.mockRejectedValueOnce(new Error("stale settings owner"));
    await expect(owner.controller.captureAsync(undefined, { intent: "move" })).rejects.toThrow(
      "stale settings owner",
    );
  });
  it("ignores a late private read after unmount without publishing a replacement draft", async () => {
    const owner = fixture();
    let resolve!: (value: string) => void;
    owner.control.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const view = owner.mount();
    view.unmount();
    await act(async () => resolve("late-secret"));
    await waitFor(() => expect(screen.queryByLabelText("Private draft")).toBeNull());
    expect(JSON.stringify(owner.controller.capture())).not.toContain("late-secret");
  });
});
