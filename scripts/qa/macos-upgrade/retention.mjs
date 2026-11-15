import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const pluginId = "qa-macos-ota-retention";
export const pluginName = "QA Mac OTA retention";
export const permissions = ["ui.trusted", "hosts.read", "history.read", "history.write", "secrets"];

async function openPlugin(runtime, pid) {
  const { native, waitUntil, hasText, tree } = runtime;
  await native("press", pid, "Plugins", "described");
  await waitUntil("installed plugin tab", async () =>
    (await tree(pid)).nodes.some((node) => node.AXTitle?.startsWith("Installed")),
  );
  await native("press", pid, "Installed", "tab-prefix");
  await waitUntil("installed retention package", async () =>
    (await tree(pid)).nodes.some((node) => node.AXTitle?.startsWith(pluginName)),
  );
  await native("press", pid, pluginName, "prefix");
  await waitUntil("retention view control", async () => hasText(await tree(pid), "OTA retention"));
  await native("press", pid, "OTA retention");
}

export async function seedRetention(runtime) {
  const { report, source, native, pid, tree, waitUntil, hasText, screenshot } = runtime;
  const folder = join(report.paths.root, "retention-plugin");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "ui"), { mode: 0o700 });
  const manifest = {
    id: pluginId,
    name: pluginName,
    version: "1.0.0",
    apiVersion: 1,
    runtime: "frontend",
    permissions,
    frontend: { entry: "ui/main.mjs", sdk: "^0.1.0" },
    views: [{ id: "main", title: "OTA retention", kind: "component" }],
  };
  const module = await readFile(join(source, "retention-plugin.mjs"));
  await writeFile(join(folder, "tunnelde-plugin.json"), JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(join(folder, "ui/main.mjs"), module, { mode: 0o600 });
  report.retentionFixture = {
    id: pluginId,
    permissions,
    runtime: "frontend",
    moduleSha256: createHash("sha256").update(module).digest("hex"),
  };
  await native("press", pid, "Plugins", "described");
  await waitUntil("plugin install control", async () => hasText(await tree(pid), "Install plugin"));
  await native("press", pid, "Install plugin");
  await waitUntil("plugin folder control", async () => hasText(await tree(pid), "Choose folder"));
  await native("press", pid, "Choose folder");
  await waitUntil("native plugin folder dialog", async () =>
    hasText(await tree(pid), "Plugin folder"),
  );
  await native("key", pid, "go-to-folder");
  await waitUntil("native path field", async () => {
    const value = await native("plugin-path", pid);
    return value.pathEntered === true;
  });
  await native("key", pid, "enter");
  await waitUntil("native folder Open control", async () => hasText(await tree(pid), "Open"));
  await tree(pid, "plugin-native-folder");
  await native("press", pid, "Open");
  await waitUntil("inspected retention manifest", async () => hasText(await tree(pid), pluginName));
  await tree(pid, "plugin-install-preview");
  await screenshot("plugin-install-preview");
  await native("press", pid, "Install");
  await waitUntil(
    "plugin install dialog closes",
    async () => !hasText(await tree(pid), "Choose folder"),
  );
  await openPlugin(runtime, pid);
  await waitUntil("explicit plugin permission approval", async () =>
    hasText(await tree(pid), "Allow and continue"),
  );
  await tree(pid, "plugin-permission-approval");
  await screenshot("plugin-permission-approval");
  await native("press", pid, "Allow and continue");
  await waitUntil("approved frontend activation", async () =>
    hasText(await tree(pid), "OTA retention ready"),
  );
  await native("press", pid, "Seed OTA data");
  await waitUntil("nonempty retention data written through public SDK", async () => {
    const value = await tree(pid);
    assert(!hasText(value, "OTA retention failed"), "Public SDK retention seed failed");
    return hasText(value, "OTA retention seeded");
  });
  await tree(pid, "plugin-seeded");
  await screenshot("plugin-seeded");
}

export async function verifyRetention(runtime, pid) {
  const { native, tree, waitUntil, hasText, screenshot } = runtime;
  await openPlugin(runtime, pid);
  await waitUntil("retained plugin approval and activation", async () => {
    const value = await tree(pid);
    assert(!hasText(value, "Allow and continue"), "The same package lost its approval");
    return hasText(value, "Verify OTA data");
  });
  await native("press", pid, "Verify OTA data");
  await waitUntil("original nonempty data read without seeding", async () => {
    const value = await tree(pid);
    assert(!hasText(value, "OTA retention failed"), "Retained data verification failed");
    return hasText(value, "OTA retention verified");
  });
  await tree(pid, "plugin-verified");
  await screenshot("plugin-verified");
}
