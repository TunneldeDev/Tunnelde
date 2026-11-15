import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repository } from "../windows-upgrade/assets.mjs";
import { verifyLocalCli } from "../local-cli/verify.mjs";
import { permissions, pluginId, seedRetention, verifyRetention } from "./retention.mjs";
import { verifyTargetQuit } from "./quit.mjs";

export async function waitUntil(label, action, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await action()) return;
    await delay(500);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

export function hasText(tree, label) {
  assert.equal(tree.traversalCompleted, true, "AX traversal hit its time, depth or node limit");
  return tree.nodes.some((node) =>
    [node.AXTitle, node.AXDescription, node.AXValue].includes(label),
  );
}

export function hasField(tree, label) {
  assert.equal(tree.traversalCompleted, true, "AX traversal hit its time, depth or node limit");
  return tree.nodes.some(
    (node) =>
      ["AXTextField", "AXTextArea", "AXSecureTextField"].includes(node.role) &&
      [node.AXTitle, node.AXDescription].includes(label),
  );
}

export function verifySeedHost(host) {
  // hosts.list exposes the stable public DTO, not the internal saved Host.
  for (const [key, value] of Object.entries({
    address: "127.0.0.1",
    port: 2209,
    username: "qa",
  })) {
    assert.equal(host[key], value, `Synthetic host ${key}`);
  }
}

export function credentialCommand(identity) {
  assert(identity && ["legacy", "immutable"].includes(identity.kind));
  assert.equal(typeof identity.id, "string");
  assert.match(identity.id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(identity.id.length, 36);
  return [identity.kind === "immutable" ? "credential-item" : "credential", identity.id];
}

export async function upgrade(runtime) {
  const retention = runtime.report.mode === "retention";
  const {
    report,
    native,
    command,
    env,
    binary,
    bundle,
    data,
    pointer,
    source,
    evidence,
    pid,
    screenshot,
    call,
    closed,
    getExit,
    ownTarget,
  } = runtime;
  const tree = async (target, label) => {
    const value = await native("tree", target);
    if (label) await writeFile(join(evidence, `${label}-ax.json`), JSON.stringify(value, null, 2));
    return value;
  };
  const live = async (...args) => {
    const response = await call("--endpoint", pointer, ...args);
    assert(!response.error, JSON.stringify(response.error));
    return response.result;
  };
  const fill = async (label, value) => {
    await command("native-fill", runtime.driver, ["fill", String(pid), label], {
      env: { ...env, MACOS_OTA_TEXT: value },
    });
    await delay(150);
  };
  const profile = async (host) =>
    JSON.parse(
      await command("read-synthetic-profile", "/usr/bin/python3", [
        join(source, "profile.py"),
        host,
      ]),
    );

  // Reference bytes are never installed or launched by this harness.
  const asset = report.releases[1].asset;
  const downloads = join(report.paths.root, "reference-download");
  await mkdir(downloads, { mode: 0o700 });
  await command(
    "download-original-reference",
    "gh",
    [
      "release",
      "download",
      report.to,
      "--repo",
      repository,
      "--pattern",
      asset.name,
      "--dir",
      downloads,
    ],
    { env: process.env, timeout: 120000 },
  );
  const archive = join(downloads, asset.name);
  const bytes = await readFile(archive);
  assert.equal(bytes.length, asset.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  const reference = join(report.paths.root, "reference");
  await mkdir(reference, { mode: 0o700 });
  await command("extract-reference-only", "/usr/bin/python3", [
    join(source, "archive.py"),
    archive,
    reference,
  ]);
  const referenceBundle = join(reference, "Tunnelde.app");
  await command("reference-codesign", "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    referenceBundle,
  ]);
  const targetHash = createHash("sha256")
    .update(await readFile(join(referenceBundle, "Contents/MacOS/tunnelde")))
    .digest("hex");
  report.referenceBinarySha256 = targetHash;

  await native("press", pid, "Save as profile…");
  await waitUntil("profile naming dialog", async () => hasText(await tree(pid), "Profile name"));
  await fill("Profile name", "OTA preserved profile 升级保留");
  await native("press", pid, "Save");
  await waitUntil("profile dialog close", async () => !hasText(await tree(pid), "Profile name"));
  await native("press", pid, "New host", "described");
  await waitUntil("new host form", async () => hasField(await tree(pid), "Password"));
  await tree(pid, "host-form");
  for (const [label, value] of [
    ["Name", "OTA preserved host 主机"],
    ["Host", "127.0.0.1"],
    ["Port", "2209"],
    ["User", "qa"],
  ])
    await fill(label, value);
  // Only the disposable original app receives this synthetic credential. Never
  // put it in argv, results, AX values or screenshots; no host credential is read.
  await fill("Password", randomBytes(32).toString("base64url"));
  await native("press", pid, "Save");
  let host;
  await waitUntil("host and credential save", async () => {
    host = (await live("hosts", "list")).hosts.find(
      (entry) => entry.name === "OTA preserved host 主机",
    );
    return host && !hasField(await tree(pid), "Password");
  });
  report.seedHost = host;
  verifySeedHost(host);
  const initialProfile = await profile(host.id);
  report.credentialBefore = await native(...credentialCommand(initialProfile.credentialIdentity));
  assert.equal(
    report.credentialBefore.status,
    0,
    "Synthetic credential metadata unavailable without UI",
  );
  assert.match(report.credentialBefore.persistentReferenceSha256, /^[a-f0-9]{64}$/);
  const retentionRuntime = { ...runtime, tree, waitUntil, hasText };
  if (retention) {
    await seedRetention(retentionRuntime);
  }
  report.profileBeforeUpdate = await profile(host.id);
  assert.deepEqual(
    report.profileBeforeUpdate.credentialIdentity,
    initialProfile.credentialIdentity,
  );
  assert(
    report.profileBeforeUpdate.profiles.some(
      (entry) => entry.name === "OTA preserved profile 升级保留",
    ),
  );
  if (retention) {
    assert(
      report.profileBeforeUpdate.history.some(
        ([command]) => command === "echo ota-preserved-history",
      ),
    );
    const grant = report.profileBeforeUpdate.security?.grants[pluginId];
    assert.match(grant?.fingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual([...grant.permissions].sort(), [...permissions].sort());
    assert.equal(report.profileBeforeUpdate.security.restricted, false);
    assert.equal(
      report.profileBeforeUpdate.pluginPackageSha256["ui/main.mjs"],
      report.retentionFixture.moduleSha256,
    );
    assert.equal(
      report.profileBeforeUpdate.security.unclean,
      true,
      "The source plugin must actually be active",
    );
  }
  report.preferencesBeforeUpdate = await live("preferences", "snapshot");

  // The status bar Updates button is distinguished from the Settings nav button
  // by its accessible description. The match must still be unique.
  await native("press", pid, "Updates", "described");
  await waitUntil("update check control", async () =>
    hasText(await tree(pid), "Check for updates"),
  );
  await native("press", pid, "Check for updates");
  await waitUntil(
    "exact public target selection",
    async () => {
      assert(!getExit(), "Source exited during its update check");
      const value = await tree(pid);
      if (hasText(value, "Download and install")) {
        assert(
          hasText(value, `Version ${report.to.slice(1)} is available`),
          "The public feed selected a different version",
        );
        return true;
      }
      return false;
    },
    90000,
  );
  await tree(pid, "selected-public-target");
  await screenshot("original-update-selected");
  report.otaAttempted = true;
  await native("press", pid, "Download and install");
  await Promise.race([closed, delay(180000, undefined, { ref: false })]);
  assert.deepEqual(
    getExit(),
    { code: 0, signal: null },
    "Original updater source did not exit cleanly",
  );
  report.sourceUpdateExit = getExit();

  let target;
  await waitUntil(
    "updater automatic relaunch",
    async () => {
      const matches = (await native("locate")).processes.filter((entry) => entry.pid !== pid);
      assert(matches.length <= 1, "Ambiguous updater target");
      if (matches.length === 1) {
        target = matches[0];
        ownTarget(target);
        return true;
      }
      return false;
    },
    60000,
  );
  report.targetIdentity = target;
  assert(target.startSeconds >= report.sourceIdentity.startSeconds);
  assert.equal(target.identifier, "dev.tunnelde.app");
  assert.equal(target.executable, binary);
  await command("installed-codesign", "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    bundle,
  ]);
  report.installedBinarySha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  assert.equal(report.installedBinarySha256, targetHash);
  assert.equal(
    (
      await command("installed-version", "/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        join(bundle, "Contents/Info.plist"),
      ])
    ).trim(),
    report.to.slice(1),
  );
  const openFiles = await command("target-database-location", "/usr/sbin/lsof", [
    "-p",
    String(target.pid),
    "-Fn",
  ]);
  report.targetDatabasePaths = openFiles
    .split("\n")
    .filter((line) => line.startsWith("n") && line.includes("tunnelde.db"))
    .map((line) => line.slice(1));
  assert(report.targetDatabasePaths.includes(join(data, "tunnelde.db")));
  await waitUntil("target automation ready", async () => {
    try {
      return (await live("app", "info")).version === report.to.slice(1);
    } catch {
      return false;
    } // Only bounded read-only app.info is retried.
  });
  assert.equal((await native("activate", target.pid)).activated, true);
  await waitUntil("target rendered controls", async () =>
    hasText(await tree(target.pid), "Updates"),
  );
  report.preferencesAfterUpdate = await live("preferences", "snapshot");
  assert.deepEqual(report.preferencesAfterUpdate.values, report.preferencesBeforeUpdate.values);
  assert.deepEqual(
    (await live("hosts", "list")).hosts.find((entry) => entry.id === host.id),
    host,
  );
  if (retention) await verifyRetention(retentionRuntime, target.pid);
  report.profileAfterUpdate = await profile(host.id);
  assert.deepEqual(report.profileAfterUpdate.profiles, report.profileBeforeUpdate.profiles);
  assert.deepEqual(report.profileAfterUpdate.history, report.profileBeforeUpdate.history);
  assert.equal(report.profileAfterUpdate.security?.restricted, false);
  assert.equal(report.profileAfterUpdate.security?.unclean, retention);
  assert.deepEqual(
    report.profileAfterUpdate.credentialIdentity,
    report.profileBeforeUpdate.credentialIdentity,
  );
  report.credentialAfter = await native(
    ...credentialCommand(report.profileAfterUpdate.credentialIdentity),
  );
  assert.deepEqual(report.credentialAfter, report.credentialBefore);
  if (retention) {
    assert.deepEqual(
      report.profileAfterUpdate.pluginPackageSha256,
      report.profileBeforeUpdate.pluginPackageSha256,
    );
    assert.deepEqual(
      report.profileAfterUpdate.security.grants,
      report.profileBeforeUpdate.security.grants,
    );
    report.pluginRecordsAccepted = true;
    report.pluginDataAccepted = false;
    report.pluginSecretValueAccepted = false;
    report.hostCredentialValueAccepted = false;
  }
  report.targetCli = await verifyLocalCli(binary, report.to.slice(1), pointer, {
    env,
    hostId: host.id,
  });
  await tree(target.pid, "automatic-target");
  await screenshot("original-automatic-target");
  await verifyTargetQuit({
    native,
    target,
    report,
    wait: waitUntil,
    capture: async () => {
      await tree(target.pid, "quit-timeout");
      await screenshot("quit-timeout");
    },
  });
  await waitUntil("target endpoint removal", async () => {
    try {
      await readFile(pointer);
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  });
  report.normalTargetQuit = {
    observedExit: true,
    exitCode: null,
    reason: "Updater target is not a child of this runner",
  };
  report.finalOwnedProcesses = (await native("locate")).processes;
  report.otaCoreAccepted = true;
  report.otaAccepted = false;
  report.retentionScope = retention
    ? "Settings/Profile/host/credential metadata, nonempty history, real approved frontend plugin/grant/fingerprint/storage, with source active recovery marker and unrestricted target; source-only secret hash, target plugin secret value and host secret value/authentication unaccepted"
    : "Actual settings/Profile/host and same credential-item metadata; no secret read, authentication or nonempty history/plugin-storage acceptance";
  report.remaining = retention
    ? [
        "Plugin secret value retention: actual run43662161457 target read required login Keychain authorization; do not repeat or change policy in unattended mode",
        "Host credential value/authentication (external value read requires Keychain access)",
        "Independent review; physical desktop/input and other M05 cases remain separate",
      ]
    : [
        "Nonempty command history",
        "Credential authentication/value retention",
        "Plugin fingerprint/approval/storage retention and recovery marker with an active plugin",
      ];
}
