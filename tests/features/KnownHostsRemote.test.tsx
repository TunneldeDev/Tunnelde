import "@/i18n/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnownHostsList } from "@/features/settings/KnownHostsList";
import { KnownHostsModelScope } from "@/lib/panels/knownHostsModel";
import { PanelInteractionScope } from "@/lib/panels/interaction";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
const mock = vi.hoisted(() => ({ knownHostsList: vi.fn(), knownHostsForget: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: mock }));
const entry = {
  host: "qa.example",
  port: 22,
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:confirmed",
  updatedAt: 7,
};
afterEach(() => vi.clearAllMocks());
it("restores the query; obtains a native guard before local consent; sends the fingerprint the user saw without reading raw IPC", async () => {
  let resolve!: (id: string) => void;
  const control = vi.fn((r) =>
    r.action === "beginInteraction"
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve(),
  );
  const client = { control } as unknown as PanelWindowClient;
  const lease = { panelId: "knownHosts", windowId: "satellite", generation: 4 };
  const refresh = vi.fn().mockResolvedValue(undefined),
    forget = vi.fn().mockResolvedValue(undefined);
  const controller = createPanelViewState({ version: 1, fields: { "known-hosts-query": "qa" } });
  render(
    <PanelInteractionScope value={{ client, lease, staged: false }}>
      <PanelViewStateScope controller={controller}>
        <KnownHostsModelScope
          value={{ entries: [entry], error: "", loading: false, refresh, forget }}
        >
          <KnownHostsList variant="sidebar" />
        </KnownHostsModelScope>
      </PanelViewStateScope>
    </PanelInteractionScope>,
  );
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("qa");
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    resolve("guard");
  });
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain(entry.fingerprint);
  fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(forget).toHaveBeenCalledExactlyOnceWith(entry);
  expect(control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "guard" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "algorithm:ed25519" } });
  expect(controller.capture().fields["known-hosts-query"]).toBe("algorithm:ed25519");
  expect(mock.knownHostsList).not.toHaveBeenCalled();
  expect(mock.knownHostsForget).not.toHaveBeenCalled();
});
it("cancel releases consent without removing a key; failed consent stays visible until cancelled", async () => {
  const control = vi.fn().mockResolvedValue("guard");
  const forget = vi.fn().mockRejectedValue(new Error("changed"));
  const lease = { panelId: "knownHosts", windowId: "satellite", generation: 4 };
  render(
    <PanelInteractionScope
      value={{ client: { control } as unknown as PanelWindowClient, lease, staged: false }}
    >
      <KnownHostsModelScope
        value={{ entries: [entry], error: "", loading: false, refresh: vi.fn(), forget }}
      >
        <KnownHostsList />
      </KnownHostsModelScope>
    </PanelInteractionScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(control.mock.calls.filter(([r]) => r.action === "endInteraction")).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(forget).toHaveBeenCalledOnce();
  expect(control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "guard" });
});
