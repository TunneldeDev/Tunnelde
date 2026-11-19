import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HostTransferDialogs } from "@/features/hosts/HostTransferDialogs";
import {
  indexHostPreview,
  hostTransferApi,
  useHostTransfer,
  type HostImportPreview,
} from "@/lib/hosts/transfer";
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
    target: { value: " B.Example " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Select all shown" }));
  fireEvent.click(screen.getByRole("button", { name: "Deselect all shown" }));
  expect(screen.getByRole("button", { name: "Export 1 host" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select all shown" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search hosts" }), {
    target: { value: "missing" },
  });
  expect(screen.getByRole("status").textContent).toBe("No matches");
  expect(
    (screen.getByRole("button", { name: "Select all shown" }) as HTMLButtonElement).disabled,
  ).toBe(true);
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
  expect(screen.getByRole("status").textContent).toMatch(/selected host or jump host conflicts/i);
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
  const pick = vi.spyOn(hostTransferApi, "pick").mockResolvedValue(null);
  const apply = vi.spyOn(hostTransferApi, "apply");
  useHostTransfer.getState().openImport();
  await act(async () => {
    render(
      <StrictMode>
        <HostTransferDialogs />
      </StrictMode>,
    );
  });
  expect(useHostTransfer.getState().dialog).toBeNull();
  expect(pick).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
});

it("can choose a valid file in place after the initial import fails", async () => {
  const pick = vi
    .spyOn(hostTransferApi, "pick")
    .mockRejectedValueOnce(new Error("Invalid host file"))
    .mockResolvedValue(preview());
  const apply = vi.spyOn(hostTransferApi, "apply");
  useHostTransfer.getState().openImport();
  render(
    <StrictMode>
      <HostTransferDialogs />
    </StrictMode>,
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Choose file…" }));
  await screen.findByRole("button", { name: "Import selected (2)" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(pick).toHaveBeenCalledTimes(2);
  expect(apply).not.toHaveBeenCalled();
});

it("explains when there are no saved hosts to export", () => {
  useHosts.setState({ hosts: [] });
  useHostTransfer.getState().openExport();
  render(<HostTransferDialogs />);
  expect(screen.getByRole("status").textContent).toBe("No saved hosts to export.");
  expect(
    (screen.getByRole("button", { name: "Export 0 hosts" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("fills a partial selection without including hosts blocked by a conflicting jump", async () => {
  const reviewed = preview(true);
  for (const id of ["c", "d"]) {
    reviewed.entries.push({ ...reviewed.entries[0]!, id, name: `Host ${id}`, requires: [] });
    reviewed.document.roots.push(id);
  }
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(reviewed);
  useHostTransfer.getState().openImport();
  render(<HostTransferDialogs />);
  const c = await screen.findByRole<HTMLInputElement>("checkbox", { name: /Host c/ });
  const d = screen.getByRole<HTMLInputElement>("checkbox", { name: /Host d/ });
  fireEvent.click(c);
  fireEvent.click(screen.getByRole("button", { name: "Select all eligible hosts" }));
  expect(c.checked && d.checked).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Host A/ }).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(c.checked || d.checked).toBe(false);
});
it("propagates conflicts across cyclic and shared jumps without blocking unrelated hosts", () => {
  const reviewed = preview(true);
  reviewed.entries[1]!.requires = ["a"];
  reviewed.entries.push(
    { ...reviewed.entries[0]!, id: "c", requires: ["a", "b"] },
    { ...reviewed.entries[0]!, id: "d", requires: [] },
  );
  const index = indexHostPreview(reviewed);
  expect(index.blocked).toEqual(new Set(["a", "b", "c"]));
  expect(index.expand(["c", "d"])).toEqual(new Set(["a", "b", "c", "d"]));
  expect(index.expand(["b"])).toEqual(new Set(["a", "b"]));
});

it("only describes proxies used by the current import selection", async () => {
  const reviewed = preview();
  reviewed.document.hosts[0]!.route.proxy = "proxy-a";
  reviewed.document.proxies.push({
    id: "proxy-a",
    name: "Corporate gateway",
    protocol: "http",
    host: "proxy.example",
    port: 3128,
    username: "",
  });
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(reviewed);
  useHostTransfer.getState().openImport();
  render(<HostTransferDialogs />);
  await screen.findByText(/Proxies to import: Corporate gateway/);
  fireEvent.click(screen.getByRole("checkbox", { name: /Host A/ }));
  expect(screen.queryByText(/Proxies to import:/)).toBeNull();
});
