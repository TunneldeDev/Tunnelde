import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { ConfigurationFormView } from "@/features/plugins/configuration/components/ConfigurationFormView";
import { PluginConfigurationSectionView } from "@/features/plugins/configuration/components/PluginConfigurationSectionView";
import type {
  ConfigurationPlugin,
  ConfigurationServices,
} from "@/features/plugins/configuration/data/services";
import type { ConfigurationSnapshot } from "@/lib/extensions/contracts/configuration/document";

vi.mock("@/store/plugins", () => {
  throw new Error("Configuration view imported main plugin owner");
});
vi.mock("@/store/dialogs", () => {
  throw new Error("Configuration view imported main consent owner");
});
vi.mock("@/lib/api/plugins/configuration", () => {
  throw new Error("Configuration view imported direct native client");
});
vi.mock("@/lib/events/native", () => {
  throw new Error("Configuration view imported native event singleton");
});
vi.mock("@tauri-apps/api/core", () => {
  throw new Error("Configuration view imported direct native invoke");
});
const schema: ConfigurationSnapshot["schema"] = {
  version: 1,
  groups: [{ id: "general", title: "General" }],
  fields: [
    {
      id: "name",
      group: "general",
      title: "Display name",
      schema: { type: "string", maxLength: 32 },
      default: "original",
    },
    {
      id: "count",
      group: "general",
      title: "Count",
      schema: { type: "integer", minimum: 0, maximum: 10 },
      default: 0,
    },
  ],
};
const plugin: ConfigurationPlugin = {
  id: "example",
  name: "Example",
  fingerprint: "package",
  configuration: schema,
};
const snapshot = (revision = "initial"): ConfigurationSnapshot => ({
  schema,
  schemaDigest: "digest",
  revision,
  storedVersion: null,
  storedDigest: null,
  status: "ready",
  values: { name: "original", count: 0 },
});
function fixture() {
  const captured = new Map<string, unknown>();
  let changed: Parameters<ConfigurationServices["observe"]>[0] | undefined;
  const services: ConfigurationServices = {
    client: {
      get: vi.fn(async () => snapshot()),
      update: vi.fn(async () => snapshot("saved")),
      migrate: vi.fn(async () => snapshot("migrated")),
      restore: vi.fn(async () => snapshot("restored")),
      backups: vi.fn(async () => []),
      deleteBackup: vi.fn(async () => {}),
    },
    observe: vi.fn(async (listener) => {
      changed = listener;
    }),
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    confirm: vi.fn(),
  };
  const mount = (visible = true) =>
    render(
      <ConfigurationFormView plugin={plugin} query="" visible={visible} services={services} />,
    );
  return { services, captured, mount, changed: () => changed };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("configuration owner-independent renderer and captured CAS drafts", () => {
  it("retains a dirty draft and its original revision when a remount observes a newer saved document", async () => {
    const owner = fixture();
    const view = owner.mount();
    await screen.findByLabelText("Display name");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "my draft" } });
    view.unmount();
    vi.mocked(owner.services.client.get).mockResolvedValueOnce({
      ...snapshot("external"),
      values: { name: "external", count: 9 },
    });
    owner.mount();
    await waitFor(() => expect(owner.services.useBusyGuard).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "my draft");
    expect(screen.getByText(i18n.t("configuration.outdated"))).toBeTruthy();
    vi.mocked(owner.services.client.update).mockRejectedValueOnce({
      code: "validation",
      message: "configuration.conflict",
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(owner.services.client.update).toHaveBeenCalledWith("example", "package", {
      expectedRevision: "initial",
      schemaDigest: "digest",
      values: { name: "my draft", count: 0 },
    });
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "my draft");
    expect(screen.getByRole("alert").textContent).toContain("changed since");
  });

  it("subscribes before its first read and ignores unrelated configuration notices", async () => {
    const owner = fixture();
    const view = owner.mount();
    await screen.findByLabelText("Display name");
    expect(vi.mocked(owner.services.observe).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(owner.services.client.get).mock.invocationCallOrder[0]!,
    );
    act(() => owner.changed()?.({ pluginId: "other", revision: "outside" }));
    expect(screen.queryByText(i18n.t("configuration.outdated"))).toBeNull();
    act(() => owner.changed()?.({ pluginId: "example", revision: "new" }));
    expect(screen.getByText(i18n.t("configuration.outdated"))).toBeTruthy();
    const signal = vi.mocked(owner.services.observe).mock.calls[0]![1];
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("preserves section query and open-group drafts through capture without automatically saving", async () => {
    const owner = fixture();
    const mount = () =>
      render(<PluginConfigurationSectionView plugins={[plugin]} services={owner.services} />);
    const view = mount();
    expect(owner.services.client.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Example"));
    await screen.findByLabelText("Display name");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "section draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search plugin settings" }), {
      target: { value: "@id:name" },
    });
    view.unmount();
    mount();
    await waitFor(() => expect(owner.services.client.get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox", { name: "Search plugin settings" })).toHaveProperty(
      "value",
      "@id:name",
    );
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "section draft");
    expect(screen.queryByRole("spinbutton", { name: "Count" })).toBeNull();
    expect(owner.services.client.update).not.toHaveBeenCalled();
  });

  it("keeps migration behind owner confirmation and denies a confirmation after the form is hidden", async () => {
    const owner = fixture();
    vi.mocked(owner.services.client.get).mockResolvedValueOnce({
      ...snapshot("old"),
      status: "migrationRequired",
    });
    const view = owner.mount();
    await screen.findByText(/needs migration/);
    fireEvent.click(screen.getByRole("button", { name: "Migrate configuration" }));
    expect(owner.services.client.migrate).not.toHaveBeenCalled();
    view.rerender(
      <ConfigurationFormView plugin={plugin} query="" visible={false} services={owner.services} />,
    );
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.services.client.migrate).not.toHaveBeenCalled();
  });

  it("deletes a backup under its captured CAS without discarding pending field edits", async () => {
    const owner = fixture();
    vi.mocked(owner.services.client.backups).mockResolvedValue([
      {
        id: "backup",
        createdAt: "2026-11-21T00:00:00Z",
        reason: "migration",
        document: {
          revision: "old",
          schemaVersion: 1,
          schemaDigest: "digest",
          values: { name: "old" },
        },
      },
    ]);
    owner.mount();
    await screen.findByLabelText("Display name");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "retain me" } });
    fireEvent.click(screen.getByText("Configuration backups", { exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(owner.services.client.deleteBackup).not.toHaveBeenCalled();
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.services.client.deleteBackup).toHaveBeenCalledWith("example", "package", {
      expectedRevision: "initial",
      schemaDigest: "digest",
      backupId: "backup",
    });
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "retain me");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});
