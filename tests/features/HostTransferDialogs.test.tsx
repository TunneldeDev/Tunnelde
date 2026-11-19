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
  vi.spyOn(hostTransferApi, "release").mockResolvedValue(undefined);
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
  fireEvent.change(screen.getByLabelText("Export password"), {
    target: { value: "test password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Export 2 hosts" }));
  await waitFor(() =>
    expect(exported).toHaveBeenCalledWith(["a", "b"], {
      includeCredentials: true,
      encrypt: true,
      password: "test password",
    }),
  );
  await waitFor(() => expect(useHostTransfer.getState().dialog).toBeNull());
});
it("skips a host whose jump dependency conflicts until explicitly imported as a copy", async () => {
  const reviewed = preview(true);
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(reviewed);
  const apply = vi
    .spyOn(hostTransferApi, "apply")
    .mockResolvedValue({ hosts: [host("new-a"), host("new-b")], credentialErrors: [] });
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
    .mockResolvedValue({ hosts: [], credentialErrors: [] });
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

it("requires encryption for credentials but allows plain configuration export", async () => {
  const exported = vi.spyOn(hostTransferApi, "export").mockResolvedValue(null);
  useHostTransfer.getState().openExport(["a"]);
  render(<HostTransferDialogs />);
  const encryption = screen.getByRole<HTMLButtonElement>("switch", { name: "Encrypt export file" });
  expect(encryption.disabled).toBe(true);
  expect(encryption.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("switch", { name: "Include saved passwords and private keys" }));
  expect(encryption.disabled).toBe(false);
  fireEvent.click(encryption);
  expect(screen.queryByLabelText("Export password")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Export 1 host" }));
  await waitFor(() =>
    expect(exported).toHaveBeenCalledWith(["a"], {
      includeCredentials: false,
      encrypt: false,
      password: null,
    }),
  );
});

it("generates a password without exporting until explicitly saved", async () => {
  vi.spyOn(hostTransferApi, "generatePassword").mockResolvedValue(
    "secure-generated-test-password123",
  );
  const exported = vi.spyOn(hostTransferApi, "export").mockResolvedValue(null);
  useHostTransfer.getState().openExport(["a"]);
  render(<HostTransferDialogs />);
  fireEvent.click(screen.getByRole("button", { name: "Export 1 host" }));
  await screen.findByText(/Save this generated password before exporting/);
  expect(exported).not.toHaveBeenCalled();
  expect(screen.getByLabelText<HTMLInputElement>("Export password").value).toBe(
    "secure-generated-test-password123",
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export 1 host" }).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "I have saved the generated password" }));
  fireEvent.click(screen.getByRole("button", { name: "Export 1 host" }));
  await waitFor(() =>
    expect(exported).toHaveBeenCalledWith(["a"], {
      includeCredentials: true,
      encrypt: true,
      password: "secure-generated-test-password123",
    }),
  );
});

it("decrypts before preview and retains the file for wrong-password retries", async () => {
  const reviewed = { ...preview(), token: "native-token", hasCredentials: true };
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue({ token: "native-token", locked: true });
  const unlock = vi
    .spyOn(hostTransferApi, "unlock")
    .mockRejectedValueOnce({ code: "validation", message: "hostTransfer.decryptFailed" })
    .mockResolvedValue(reviewed);
  const apply = vi
    .spyOn(hostTransferApi, "apply")
    .mockResolvedValue({ hosts: [], credentialErrors: [] });
  useHostTransfer.getState().openImport();
  render(<HostTransferDialogs />);
  const password = await screen.findByLabelText("File password");
  expect(screen.queryByText(/This file has no credentials/)).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /Host A/ })).toBeNull();
  fireEvent.change(password, { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Decrypt and preview" }));
  await screen.findByText(/Incorrect password or damaged/);
  expect(apply).not.toHaveBeenCalled();
  fireEvent.change(password, { target: { value: "correct" } });
  fireEvent.keyDown(password, { key: "Enter" });
  await screen.findByRole("checkbox", { name: /Host A/ });
  expect(unlock).toHaveBeenLastCalledWith("native-token", "correct");
  expect(screen.queryByLabelText("File password")).toBeNull();
  expect(screen.getByText(/Included credentials will be saved/)).toBeTruthy();
});

it("retries only failed credential saving without importing hosts twice", async () => {
  const reviewed = { ...preview(), token: "native-token", hasCredentials: true };
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue(reviewed);
  const apply = vi
    .spyOn(hostTransferApi, "apply")
    .mockResolvedValue({ hosts: [host("new-a")], credentialErrors: ["Host A"] });
  const retry = vi
    .spyOn(hostTransferApi, "retryCredentials")
    .mockResolvedValue({ hosts: [host("new-a")], credentialErrors: [] });
  useHostTransfer.getState().openImport();
  render(<HostTransferDialogs />);
  fireEvent.click(await screen.findByRole("button", { name: "Import selected (2)" }));
  await screen.findByText(/Hosts were imported, but some credentials/);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Import selected (2)" }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry saving credentials" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("native-token"));
  expect(apply).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(useHostTransfer.getState().dialog).toBeNull());
});

it("releases native secret context on unmount, but not during StrictMode replay", async () => {
  vi.spyOn(hostTransferApi, "pick").mockResolvedValue({ ...preview(), token: "native-token" });
  const release = vi.spyOn(hostTransferApi, "release");
  useHostTransfer.getState().openImport();
  const view = render(
    <StrictMode>
      <HostTransferDialogs />
    </StrictMode>,
  );
  await screen.findByRole("checkbox", { name: /Host A/ });
  expect(release).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(release).toHaveBeenCalledWith("native-token"));
});
