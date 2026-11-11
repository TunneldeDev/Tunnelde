import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { PluginConfigurationSection } from "@/features/plugins/configuration/components/PluginConfigurationSection";
import { ConfigurationForm } from "@/features/plugins/configuration/components/ConfigurationForm";
import { pluginConfigurationApi as client } from "@/lib/api/plugins/configuration";
import { nativeEvents } from "@/lib/events/native";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import type { PluginInfo } from "@/lib/api/types";
import type { ConfigurationSnapshot } from "@/lib/extensions/contracts/configuration/document";

vi.mock("@/lib/api/plugins/configuration", () => ({
  pluginConfigurationApi: {
    get: vi.fn(),
    update: vi.fn(),
    migrate: vi.fn(),
    restore: vi.fn(),
    backups: vi.fn(),
    deleteBackup: vi.fn(),
  },
}));
vi.mock("@/lib/events/native", () => ({
  nativeEvents: { on: vi.fn().mockResolvedValue(() => {}) },
}));
const schema: ConfigurationSnapshot["schema"] = {
  version: 1,
  groups: [{ id: "general", title: "General" }],
  fields: [
    {
      id: "enabled",
      group: "general",
      title: "Enabled",
      schema: { type: "boolean" },
      default: false,
    },
    {
      id: "name",
      group: "general",
      title: "Display name",
      schema: { type: "string", maxLength: 16 },
      default: "test",
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
const snapshot = (revision = "initial"): ConfigurationSnapshot => ({
  schema,
  schemaDigest: "digest",
  revision,
  storedVersion: null,
  storedDigest: null,
  status: "ready",
  values: { enabled: false, name: "test", count: 0 },
});
const plugin = {
  id: "config-qa",
  name: "Config QA",
  fingerprint: "package",
  configuration: schema,
  status: "stopped",
} as PluginInfo;
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  vi.mocked(client.get).mockResolvedValue(snapshot());
  vi.mocked(client.backups).mockResolvedValue([]);
  vi.mocked(client.update).mockImplementation(async (_id, _fingerprint, update) => ({
    ...snapshot("next"),
    values: update.values,
  }));
  vi.mocked(nativeEvents.on).mockResolvedValue(() => {});
  usePlugins.setState({ items: [plugin] });
  useDialogs.setState({ dialog: { kind: "none" } });
});
const open = async () => {
  render(<PluginConfigurationSection />);
  fireEvent.click(screen.getByText("Config QA"));
  await screen.findByLabelText("Display name");
};
const confirm = async () => {
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  if (dialog.kind === "confirm")
    await act(async () => {
      await dialog.onConfirm();
    });
};

it("loads only an expanded plugin and saves stopped-plugin settings with false, zero and an explicit CAS", async () => {
  render(<PluginConfigurationSection />);
  expect(client.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Config QA"));
  await screen.findByLabelText("Display name");
  expect(screen.getByLabelText("Count")).toHaveProperty("value", "0");
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "changed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(client.update).toHaveBeenCalledWith("config-qa", "package", {
      expectedRevision: "initial",
      schemaDigest: "digest",
      values: { enabled: false, name: "changed", count: 0 },
    }),
  );
  await screen.findByText("No unsaved changes");
});
it("preserves edits on external changes and CAS failures without retrying or loading over the draft", async () => {
  vi.mocked(client.update).mockRejectedValue({
    code: "validation",
    message: "configuration.conflict",
  });
  await open();
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "draft" } });
  const listener = vi.mocked(nativeEvents.on).mock.calls[0]![1] as (event: {
    pluginId: string;
    revision: string;
    schemaDigest: string;
  }) => void;
  act(() => listener({ pluginId: plugin.id, revision: "external", schemaDigest: "digest" }));
  expect(screen.getByLabelText("Display name")).toHaveProperty("value", "draft");
  expect(client.get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("changed since");
  expect(client.update).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
  expect(client.get).toHaveBeenCalledTimes(1);
  await confirm();
  expect(screen.getByLabelText("Display name")).toHaveProperty("value", "test");
});
it("blocks invalid values and requires confirmation for schema migration", async () => {
  const pending = { ...snapshot("old"), status: "migrationRequired" as const, storedVersion: 1 };
  pending.schema = { ...schema, version: 2 };
  vi.mocked(client.get).mockResolvedValue(pending);
  vi.mocked(client.migrate).mockResolvedValue(snapshot("migrated"));
  render(<ConfigurationForm plugin={plugin} query="" visible />);
  await screen.findByText(/needs migration/);
  expect(client.migrate).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Display name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Migrate configuration" }));
  expect(client.migrate).not.toHaveBeenCalled();
  await confirm();
  await screen.findByLabelText("Display name");
  fireEvent.change(screen.getByLabelText("Count"), { target: { value: "1.5" } });
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
});
it("deleting a backup preserves unsaved edits and uses the current revision", async () => {
  vi.mocked(client.backups).mockResolvedValue([
    {
      id: "backup",
      createdAt: "2026-11-10T00:00:00Z",
      reason: "migration",
      document: {
        revision: "old",
        schemaVersion: 1,
        schemaDigest: "digest",
        values: { name: "old" },
      },
    },
  ]);
  vi.mocked(client.deleteBackup).mockResolvedValue(undefined);
  await open();
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "draft" } });
  fireEvent.click(screen.getByText("Configuration backups", { exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await confirm();
  expect(client.deleteBackup).toHaveBeenCalledWith(plugin.id, plugin.fingerprint, {
    expectedRevision: "initial",
    schemaDigest: "digest",
    backupId: "backup",
  });
  expect(screen.getByLabelText("Display name")).toHaveProperty("value", "draft");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
});
it("a confirmation retained after a form is hidden cannot mutate configuration", async () => {
  const pending = { ...snapshot("old"), status: "migrationRequired" as const };
  vi.mocked(client.get).mockResolvedValue(pending);
  const view = render(<ConfigurationForm plugin={plugin} query="" visible />);
  await screen.findByText(/needs migration/);
  fireEvent.click(screen.getByRole("button", { name: "Migrate configuration" }));
  view.rerender(<ConfigurationForm plugin={plugin} query="" visible={false} />);
  await confirm();
  expect(client.migrate).not.toHaveBeenCalled();
});
it("@ filters discover fields; bare filters remain literal, and hiding groups preserves drafts", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "draft" } });
  const search = screen.getByRole("textbox", { name: "Search plugin settings" });
  fireEvent.change(search, { target: { value: "@plugin:config-qa @id:name" } });
  expect(screen.getByLabelText("Display name")).toHaveProperty("value", "draft");
  expect(screen.queryByRole("spinbutton", { name: "Count" })).toBeNull();
  fireEvent.change(search, { target: { value: "plugin:config-qa" } });
  expect(screen.getByText("Config QA").closest("details")).toHaveProperty("hidden", true);
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByLabelText("Display name")).toHaveProperty("value", "draft");
  fireEvent.click(screen.getByRole("button", { name: "Filter presets" }));
  expect(screen.getByText("@plugin:config-qa")).toBeTruthy();
});
