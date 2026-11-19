import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HostTransferDialogs } from "@/features/hosts/HostTransferDialogs";
import { hostTransferApi, useHostTransfer, type HostImportPreview } from "@/lib/hosts/transfer";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import type { Host } from "@/lib/api/types";
import i18n from "@/i18n/i18n";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const host = (id: string): Host => ({
  id,
  name: `Host ${id.toUpperCase()}`,
  host: `${id}.example`,
  port: 22,
  username: "user",
  groupId: null,
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
});
function preview(conflict = false): HostImportPreview {
  const records = [host("a"), host("b")].map(
    ({ id, name, host, port, username, authMethod, groupId, favorite, color, tags, note }) => ({
      id,
      name,
      host,
      port,
      username,
      authMethod,
      groupId,
      favorite,
      color,
      tags,
      note,
      route: { proxy: "direct", jumpHosts: id === "a" ? ["b"] : [] },
    }),
  );
  return {
    revision: "review-1",
    entries: records.map((host) => ({
      id: host.id,
      name: host.name,
      address: `${host.username}@${host.host}:${host.port}`,
      conflict: conflict && host.id === "b",
      dependency: host.id === "b",
      requires: host.route.jumpHosts,
      forwards: 0,
      mounts: 0,
    })),
    document: {
      format: "tunnelde-hosts",
      version: 1,
      platform: "macos",
      roots: ["a"],
      hosts: records,
      folders: [],
      proxies: [],
      forwardGroups: [],
      forwards: [],
      mountGroups: [],
      mountRules: [],
    },
  };
}
beforeEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage("en-US");
  useHostTransfer.getState().close();
  useHosts.setState({
    hosts: [host("a"), host("b")],
    groups: [],
    load: vi.fn(async () => true),
    receiveSavedHost: vi.fn(),
  });
  useSettings.setState({ load: vi.fn(async () => undefined) });
});
it("exports only checked saved hosts while preserving selection across filtering", async () => {
  const exported = vi.spyOn(hostTransferApi, "export").mockResolvedValue("/tmp/hosts.json");
  useHostTransfer.getState().openExport(["a"]);
  render(<HostTransferDialogs />);
  expect((screen.getByRole("checkbox", { name: /Host A/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: /^Host B\b/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search hosts" }), {
    target: { value: "b.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Select / deselect all" }));
  fireEvent.click(screen.getByRole("button", { name: "Export 2 hosts" }));
  await waitFor(() => expect(exported).toHaveBeenCalledWith(["a", "b"]));
  await waitFor(() => expect(useHostTransfer.getState().dialog).toBeNull());
});
it("skips a host whose jump dependency conflicts until explicitly imported as a copy", async () => {
  const reviewed = preview(true);
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(reviewed);
  const apply = vi
    .spyOn(hostTransferApi, "apply")
    .mockResolvedValue([host("new-a"), host("new-b")]);
  useHostTransfer.getState().openImport();
  render(<HostTransferDialogs />);
  const target = await screen.findByRole("checkbox", { name: /Host A/ });
  expect((target as HTMLInputElement).checked).toBe(false);
  fireEvent.click(target);
  const dependency = screen.getByRole("checkbox", { name: /^Host B\b/ }) as HTMLInputElement;
  expect(dependency.checked).toBe(true);
  expect(dependency.disabled).toBe(true);
  const submit = screen.getByRole("button", { name: "Import selected (2)" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Import selected conflicting hosts as copies" }),
  );
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(apply).toHaveBeenCalledWith(reviewed, ["a"], true, {}));
  await waitFor(() => expect(useHosts.getState().load).toHaveBeenCalled());
});
it("retains the import selection on a stale preview and retries with a refreshed revision", async () => {
  const reviewed = preview();
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(reviewed);
  vi.spyOn(hostTransferApi, "preview").mockResolvedValue({ ...reviewed, revision: "review-2" });
  const apply = vi
    .spyOn(hostTransferApi, "apply")
    .mockRejectedValueOnce({ code: "validation", message: "hostTransfer.changed" })
    .mockResolvedValue([]);
  useHostTransfer.getState().openImport();
  render(<HostTransferDialogs />);
  fireEvent.click(await screen.findByRole("button", { name: "Import selected (2)" }));
  expect((await screen.findByRole("alert")).textContent).toContain("preview is stale");
  expect(useHostTransfer.getState().dialog?.kind).toBe("import");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Import selected (2)" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import selected (2)" }));
  await waitFor(() =>
    expect(apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: "review-2" }),
      ["a"],
      false,
      {},
    ),
  );
});
it("cancelling the native picker closes without applying configuration", async () => {
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(null);
  const apply = vi.spyOn(hostTransferApi, "apply");
  useHostTransfer.getState().openImport();
  await act(async () => {
    render(<HostTransferDialogs />);
  });
  expect(useHostTransfer.getState().dialog).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
