import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { repository } from "../windows-upgrade/assets.mjs";
import { packagedAsset } from "../local-cli/assets.mjs";
import { applicationEnvironment, offlineCli, verifyLocalCli } from "../local-cli/verify.mjs";
import { checkedDirectory, hostedContext, requireCapabilities } from "./guard.mjs";
import { hasText, upgrade, waitUntil } from "./ota.mjs";
import { collectFailureDiagnostics } from "./diagnostics.mjs";

const run = promisify(execFile);
const user = userInfo();
const context = hostedContext({
  env: process.env,
  platform: process.platform,
  architecture: process.arch,
  user,
  home: homedir(),
  cwd: process.cwd(),
  workflowFile: "macos-public-ota.yml",
  acknowledgement: "original-public-ota",
});
const mode = process.env.MACOS_OTA_MODE;
assert(
  ["inspect", "upgrade", "retention"].includes(mode),
  "Expected inspect, upgrade or retention mode",
);
for (const path of [context.home, context.workspace, context.temp])
  await checkedDirectory(path, user.uid);
const source = dirname(fileURLToPath(import.meta.url));
assert.equal(await realpath(source), join(context.workspace, "scripts/qa/macos-upgrade"));
await mkdir(context.root, { mode: 0o700 });
const evidence = join(context.root, "evidence");
await mkdir(evidence, { mode: 0o700 });
const data = join(context.home, "Library/Application Support/dev.tunnelde.app");
const pointer = join(data, "automation.json");
const driver = join(context.root, "driver");
const install = join(context.root, "install");
const bundle = join(install, "Tunnelde.app");
const binary = join(bundle, "Contents/MacOS/tunnelde");
const report = {
  schemaVersion: 1,
  head: process.env.GITHUB_SHA,
  startedAt: new Date().toISOString(),
  mode,
  otaAttempted: false,
  otaAccepted: false,
  from: process.env.UPGRADE_FROM,
  to: process.env.UPGRADE_TO,
  platform: process.platform,
  architecture: process.arch,
  paths: { ...context, data, bundle },
  commands: [],
  screenshots: [],
  checks: [],
};
let child, closed, exit;
let ownedTarget;
let stdout = "",
  stderr = "";

function environment() {
  const env = applicationEnvironment();
  for (const key of Object.keys(env)) {
    if (/^(TUNNELDE_|DYLD_|ACTIONS_|GH_)/.test(key)) delete env[key];
  }
  return env;
}

async function command(name, executable, args, options = {}) {
  const item = { name, executable, args };
  report.commands.push(item);
  try {
    const result = await run(executable, args, {
      env: environment(),
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    });
    Object.assign(item, { exitCode: 0, stdout: result.stdout, stderr: result.stderr });
    return result.stdout;
  } catch (error) {
    Object.assign(item, {
      exitCode: error.code ?? null,
      signal: error.signal ?? null,
      stdout: error.stdout ?? "",
      stderr: (error.stderr ?? "").replace(/https:\/\/\S+/g, "<redacted-url>"),
    });
    throw new Error(`Command ${name} failed (${error.code ?? error.signal ?? "unknown"})`);
  }
}

async function native(action, ...args) {
  return JSON.parse(await command(`native-${action}`, driver, [action, ...args.map(String)]));
}

async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.fail(`Disposable profile is not pristine: ${path}`);
}

async function waitFor(label, action, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    assert(!exit, `Source process exited while waiting for ${label}: ${JSON.stringify(exit)}`);
    if (await action()) return;
    await delay(300);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function screenshot(label) {
  const path = join(evidence, `${label}.png`);
  await command("desktop-screenshot", "/usr/sbin/screencapture", ["-x", path]);
  const bytes = await readFile(path);
  assert(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  report.screenshots.push({
    label,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

try {
  assert.equal(
    (await command("checkout-head", "/usr/bin/git", ["rev-parse", "HEAD"])).trim(),
    report.head,
  );
  assert.equal(
    await command("checkout-status", "/usr/bin/git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]),
    "",
  );
  report.sourceFiles = {};
  for (const name of [
    "public.mjs",
    "ota.mjs",
    "driver.m",
    "diagnostics.mjs",
    "guard.mjs",
    "archive.py",
    "profile.py",
    "credential.py",
    "retention.mjs",
    "retention-plugin.mjs",
  ]) {
    report.sourceFiles[name] = createHash("sha256")
      .update(await readFile(join(source, name)))
      .digest("hex");
  }
  await command("compile-native-driver", "/usr/bin/xcrun", [
    "clang",
    "-fobjc-arc",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "Security",
    "-framework",
    "LocalAuthentication",
    "-framework",
    "SystemConfiguration",
    join(source, "driver.m"),
    "-o",
    driver,
  ]);
  report.driverSha256 = createHash("sha256")
    .update(await readFile(driver))
    .digest("hex");
  report.capabilities = await native("capabilities");
  requireCapabilities(report.capabilities);
  for (const path of [
    data,
    join(context.home, "Library/Preferences/dev.tunnelde.app.plist"),
    join(context.home, "Library/Caches/dev.tunnelde.app"),
    join(context.home, "Library/Logs/dev.tunnelde.app"),
    join(context.home, "Applications/Tunnelde.app"),
    "/Applications/Tunnelde.app",
  ])
    await absent(path);
  report.profileBefore = await native("profile");
  assert.equal(
    report.profileBefore.serviceAbsent,
    true,
    "An existing app credential or blocked credential lookup forbids startup",
  );
  assert.equal(report.profileBefore.existingApps, 0);
  report.checks.push(
    "Pristine disposable native profile and absent production-service credentials; driver capabilities available",
  );
  const releases = [];
  for (const tag of [report.from, report.to]) {
    const release = JSON.parse(
      await command("release-metadata", "gh", ["api", `repos/${repository}/releases/tags/${tag}`], {
        env: process.env,
        timeout: 45000,
      }),
    );
    assert.equal(release.prerelease, false);
    releases.push({ tag, asset: packagedAsset(release, tag, "darwin", process.arch) });
  }
  report.releases = releases;
  const asset = releases[0].asset;
  const downloads = join(context.root, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  await command(
    "download-original-source",
    "gh",
    [
      "release",
      "download",
      report.from,
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
  await mkdir(install, { mode: 0o700 });
  await command("extract-verified-original", "/usr/bin/python3", [
    join(source, "archive.py"),
    archive,
    install,
  ]);
  assert.equal(await realpath(binary), binary);
  for (const [field, expected] of [
    ["CFBundleIdentifier", "dev.tunnelde.app"],
    ["CFBundleShortVersionString", report.from.slice(1)],
    ["CFBundleExecutable", "tunnelde"],
  ]) {
    assert.equal(
      (
        await command(`plist-${field}`, "/usr/libexec/PlistBuddy", [
          "-c",
          `Print :${field}`,
          join(bundle, "Contents/Info.plist"),
        ])
      ).trim(),
      expected,
    );
  }
  await command("original-codesign", "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    bundle,
  ]);
  await command("original-architecture", "/usr/bin/lipo", [
    binary,
    "-verify_arch",
    process.arch === "arm64" ? "arm64" : "x86_64",
  ]);
  report.sourceBinarySha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const env = environment();
  const { call } = await offlineCli(binary, report.from.slice(1), env);
  child = spawn(binary, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (bytes) => {
    stdout = (stdout + bytes).slice(-256000);
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-256000);
  });
  closed = new Promise((resolve) => {
    child.once("error", (error) => {
      exit = { error: String(error) };
      resolve(exit);
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });
  report.sourcePid = child.pid;
  await waitFor(
    "native automation pointer",
    async () => {
      try {
        await readFile(pointer);
        return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    60000,
  );
  report.sourceIdentity = await native("identity", child.pid);
  assert.equal((await native("activate", child.pid)).activated, true);
  const openFiles = await command("actual-database-location", "/usr/sbin/lsof", [
    "-p",
    String(child.pid),
    "-Fn",
  ]);
  report.databasePaths = openFiles
    .split("\n")
    .filter((line) => line.startsWith("n") && line.includes("tunnelde.db"))
    .map((line) => line.slice(1));
  assert(
    report.databasePaths.includes(join(data, "tunnelde.db")),
    "Source did not open the native database",
  );
  const live = async (...args) => {
    const response = await call("--endpoint", pointer, ...args);
    assert(!response.error, JSON.stringify(response.error));
    return response.result;
  };
  const preferences = await live("preferences", "snapshot");
  report.seedPreferences = await live(
    "preferences",
    "update",
    "--params",
    JSON.stringify({
      revision: preferences.revision,
      changes: {
        general: { language: "en-US", closeToTray: false },
        editor: { tabSize: 8 },
        updates: { autoCheck: false, channel: "stable", source: "github", sourceUrl: "" },
      },
    }),
  );
  report.sourceCli = await verifyLocalCli(binary, report.from.slice(1), pointer, { env });
  await waitFor("rendered source controls", async () =>
    hasText(await native("tree", child.pid), "Updates"),
  );
  await screenshot("source-original-started");
  await writeFile(
    join(evidence, "startup-ax.json"),
    JSON.stringify(await native("tree", child.pid), null, 2),
  );
  await native("press", child.pid, "Updates", "described");
  await waitFor("rendered Updates controls", async () =>
    hasText(await native("tree", child.pid), "Check for updates"),
  );
  await writeFile(
    join(evidence, "updates-ax.json"),
    JSON.stringify(await native("tree", child.pid), null, 2),
  );
  await screenshot("original-updates-controls");
  if (mode !== "inspect") {
    await upgrade({
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
      pid: child.pid,
      driver,
      screenshot,
      call,
      closed,
      getExit: () => exit,
      ownTarget: (identity) => {
        ownedTarget = identity;
      },
    });
  } else {
    await native("key", child.pid, "quit");
    await Promise.race([closed, delay(10000)]);
    assert.deepEqual(exit, { code: 0, signal: null }, "Original GUI did not quit normally");
    await absent(pointer);
    report.normalQuit = exit;
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack ?? error);
  if (report.otaAttempted) {
    try {
      report.failureDiagnostics = await collectFailureDiagnostics({
        report,
        native,
        command,
        binary,
        bundle,
        evidence,
        home: context.home,
      });
    } catch (diagnosticError) {
      report.failureDiagnosticError = String(diagnosticError);
    }
  }
  if (child) {
    try {
      const pid = ownedTarget?.pid ?? child.pid;
      await writeFile(
        join(evidence, "failure-ax.json"),
        JSON.stringify(await native("tree", pid), null, 2),
      );
    } catch (error) {
      report.failureCaptureError = String(error);
    }
    try {
      await screenshot("failure");
    } catch (error) {
      report.failureScreenshotError = String(error);
    }
  }
  process.exitCode = 1;
} finally {
  if (child && !exit) {
    // This is the still-owned direct child, never a PID obtained from a stale file.
    child.kill("SIGTERM");
    await Promise.race([closed, delay(5000)]);
    if (!exit) {
      child.kill("SIGKILL");
      await closed;
    }
    report.forcedCleanup = true;
  }
  if (report.otaAttempted && !report.normalTargetQuit) {
    try {
      const targets = (await native("locate")).processes.filter(
        (identity) => identity.pid !== child?.pid,
      );
      if (!ownedTarget && targets.length === 1) ownedTarget = targets[0];
      if (
        ownedTarget &&
        targets.some((identity) =>
          ["pid", "startSeconds", "startMicroseconds", "executable", "identifier"].every(
            (key) => identity[key] === ownedTarget[key],
          ),
        )
      ) {
        const stop = async (signal) =>
          native(
            "stop",
            ownedTarget.pid,
            ownedTarget.startSeconds,
            ownedTarget.startMicroseconds,
            signal,
          );
        report.targetForcedCleanup = await stop("TERM");
        try {
          await waitUntil(
            "owned target termination",
            async () => !(await native("locate")).processes.length,
            5000,
          );
        } catch {
          report.targetForcedKill = await stop("KILL");
        }
      }
      report.finalOwnedProcesses = (await native("locate")).processes;
    } catch (error) {
      report.targetCleanupError = String(error);
    }
  }
  report.sourceExit = exit;
  report.finishedAt = new Date().toISOString();
  report.cleanup =
    "Owned direct source and any start-identity-verified updater target only; native profile retained for runner disposal";
  const redact = (text) => text.replace(/https:\/\/[^\s"<>]*[?][^\s"<>]*/g, "<redacted-url>");
  await writeFile(join(evidence, "source-stdout.log"), redact(stdout), { mode: 0o600 });
  await writeFile(join(evidence, "source-stderr.log"), redact(stderr), { mode: 0o600 });
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      otaAccepted: report.otaAccepted,
      otaCoreAccepted: report.otaCoreAccepted ?? false,
      evidence,
      failure: report.failure,
    }),
  );
}
