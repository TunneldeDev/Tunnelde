import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function seed(desktop, root) {
  await desktop.invoke("settings_update", {
    patch: {
      language: "en-US",
      theme: "light",
      monoFontSize: 17,
      autoCheckUpdates: false,
      closeToTray: false,
      recordTerminalHistory: true,
    },
  });
  await desktop.invoke("plugin_set_restricted", { enabled: false });
  const group = await desktop.invoke("group_create", { input: { name: "升级验收" } });
  const host = await desktop.invoke("host_create", {
    input: {
      name: "Preserved host 主机",
      groupId: group.id,
      host: "127.0.0.1",
      port: 2209,
      username: "qa",
      authMethod: "password",
      favorite: true,
      tags: ["验收", "upgrade"],
      note: "retain exact metadata",
    },
  });
  await desktop.invoke("history_record", { hostId: host.id, command: "echo preserved-history" });
  const profiles = await desktop.invoke("settings_profile_save", {
    id: null,
    name: "升级保留",
    settings: { language: "en-US", theme: "light", monoFontSize: 17 },
  });
  const pkg = join(root, "package");
  await mkdir(join(pkg, "ui"), { recursive: true });
  await writeFile(
    join(pkg, "ui", "main.mjs"),
    "export function activate(context){globalThis.__qaUpgrade=context;}",
  );
  await writeFile(
    join(pkg, "tunnelde-plugin.json"),
    JSON.stringify({
      id: "qa-installer-upgrade",
      name: "QA installer upgrade",
      version: "1.0.0",
      apiVersion: 1,
      runtime: "frontend",
      permissions: ["ui.trusted"],
      frontend: { entry: "ui/main.mjs", sdk: "^0.1.0" },
    }),
  );
  const plugin = await desktop.invoke("plugin_install", { path: pkg });
  await desktop.invoke("plugin_set_permissions", {
    id: plugin.id,
    permissions: plugin.permissions,
    expectedFingerprint: plugin.fingerprint,
  });
  await desktop.activate(plugin);
  const value = { message: "升级保留", nested: { count: 42 } };
  await desktop.call("storage.set", { key: "upgrade-check", value });
  assert.deepEqual(await desktop.call("storage.get", { key: "upgrade-check" }), value);
  const security = await desktop.invoke("plugin_security_state");
  assert.equal(security.restricted, false);
  assert.deepEqual(security.grants[plugin.id], ["ui.trusted"]);
  return { group, host, profiles, plugin, value, security };
}

export async function verify(desktop, expected) {
  const security = await desktop.invoke("plugin_security_state");
  assert.equal(security.restricted, false);
  assert.equal(security.recoverySuggested, false);
  assert.deepEqual(security.grants, expected.security.grants);
  const settings = await desktop.invoke("settings_get");
  for (const [key, value] of Object.entries({
    language: "en-US",
    theme: "light",
    monoFontSize: 17,
    autoCheckUpdates: false,
    closeToTray: false,
    recordTerminalHistory: true,
  }))
    assert.equal(settings[key], value, `Preserved setting ${key}`);
  const snapshot = await desktop.invoke("hosts_snapshot");
  assert.deepEqual(
    snapshot.hosts.find((item) => item.id === expected.host.id),
    expected.host,
  );
  assert(
    snapshot.groups.some(
      (item) => item.id === expected.group.id && item.name === expected.group.name,
    ),
  );
  assert(
    (await desktop.invoke("history_list", { hostId: expected.host.id, limit: 20 })).some(
      (item) => item.command === "echo preserved-history",
    ),
  );
  assert.deepEqual(await desktop.invoke("settings_profiles_list"), expected.profiles);
  const plugin = (await desktop.invoke("plugins_list")).find(
    (item) => item.id === expected.plugin.id,
  );
  assert(plugin, "Installed plugin retained");
  assert.equal(plugin.fingerprint, expected.plugin.fingerprint);
  await desktop.activate(plugin);
  assert.deepEqual(await desktop.call("storage.get", { key: "upgrade-check" }), expected.value);
}
