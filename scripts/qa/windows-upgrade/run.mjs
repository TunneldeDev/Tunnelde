import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertUpgrade, releaseAsset, repository } from "./assets.mjs";
import { Desktop } from "./desktop.mjs";
import { seed, verify } from "./data.mjs";
import { verifyCli } from "./cli.mjs";
import { cleanupUpdated, quitUpdated, updateInApplication } from "./ota.mjs";
import { nativeProfileDirectory } from "./profile.mjs";

// Real installers alter per-user registration. Never run on a user's workstation
// or a self-hosted runner, even when an alternate installation path is supplied.
assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert(process.env.RUNNER_TEMP);
const root = resolve(process.env.RUNNER_TEMP, "tunnelde-upgrade");
const evidence = join(root, "evidence");
await mkdir(evidence, { recursive: true });
const { chromium } = await import(
  pathToFileURL(join(process.env.RUNNER_TEMP, "upgrade-tools/node_modules/playwright/index.mjs"))
    .href
);
const run = promisify(execFile);
const tags = [process.env.UPGRADE_FROM, process.env.UPGRADE_TO];
assertUpgrade(...tags);
const inApplication = process.env.UPGRADE_IN_APP === "true";
const report = {
  scope: inApplication
    ? "Actual public Windows x64 application-initiated signed update, automatic installer restart and shared isolated data retention. Not macOS/Linux OTA, saved credentials or every historical upgrade path."
    : "Actual public Windows x64 NSIS install/upgrade with shared isolated application data. Not in-app OTA, physical macOS/Linux, credentials or user-profile migration acceptance.",
  tags,
  checks: [],
  assets: [],
  pageErrors: [],
  exits: [],
};
const desktop = new Desktop(chromium, root, report);
if (inApplication) {
  desktop.nativeProfile = true;
  desktop.dataDir = nativeProfileDirectory(process.env);
  // Never overwrite or delete a profile that this disposable run did not own.
  await lstat(desktop.dataDir).then(
    () => assert.fail("Refusing to use an existing native application profile"),
    (error) => assert.equal(error.code, "ENOENT"),
  );
}
let installedBinary;

async function install(tag) {
  const { stdout } = await run("gh", ["api", `repos/${repository}/releases/tags/${tag}`], {
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const asset = releaseAsset(JSON.parse(stdout), tag);
  const download = join(root, "downloads", tag);
  await mkdir(download, { recursive: true });
  await run(
    "gh",
    ["release", "download", tag, "--repo", repository, "--pattern", asset.name, "--dir", download],
    { timeout: 120000 },
  );
  const path = join(download, asset.name);
  const bytes = await readFile(path);
  assert.equal(bytes.length, asset.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  report.assets.push({ tag, ...asset });
  const installPath = join(root, "installed");
  // NSIS requires /D to be the last argument and consumes its unquoted remainder.
  assert(!/\s/.test(installPath), "QA install path must avoid NSIS argument quoting ambiguity");
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  let result;
  try {
    result = await run(path, ["/S", `/D=${installPath}`], {
      timeout: 120000,
      windowsHide: true,
      env,
    });
  } catch (error) {
    await writeFile(
      join(evidence, `${tag}-installer.log`),
      String(error.stdout ?? "") + String(error.stderr ?? ""),
    );
    throw error;
  }
  await writeFile(join(evidence, `${tag}-installer.log`), result.stdout + result.stderr);
  const names = (await readdir(installPath)).filter(
    (name) => name.toLowerCase() === "tunnelde.exe",
  );
  assert.equal(names.length, 1, "Installed desktop executable exists");
  report.checks.push(
    `${tag} public installer SHA256/size verified and silent installation completed`,
  );
  return join(installPath, names[0]);
}

try {
  const before = await install(tags[0]);
  installedBinary = before;
  await desktop.start(before, tags[0].slice(1));
  const expected = await seed(desktop, root);
  await desktop.page.screenshot({ path: join(evidence, "before.png"), animations: "disabled" });
  let after;
  if (inApplication) {
    await updateInApplication(desktop, before, tags[1], report);
    after = before;
  } else {
    await desktop.quit();
    report.checks.push(
      "Old installed application persisted settings/profile/host/history/plugin approval/storage and exited normally",
    );
    after = await install(tags[1]);
    await desktop.start(after, tags[1].slice(1));
  }
  await verify(desktop, expected);
  if (process.env.UPGRADE_CHECK_CLI === "true") {
    await verifyCli(after, tags[1].slice(1), desktop.dataDir, expected.host.id);
    report.checks.push(
      "Actual installed desktop CLI executed offline discovery/version and all seven live methods, including conditional preferences update and restore",
    );
  }
  await desktop.page.screenshot({ path: join(evidence, "after.png"), animations: "disabled" });
  if (inApplication) await quitUpdated(desktop, after, report);
  else await desktop.quit();
  assert.deepEqual(report.pageErrors, []);
  report.checks.push(
    "Upgraded installed application retained all seeded data and plugin fingerprint/approval/storage without recovery mode; zero page errors and normal exit",
  );
} catch (error) {
  report.failure = String(error?.stack ?? error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await desktop.cleanup();
  if (inApplication && installedBinary) await cleanupUpdated(installedBinary);
  try {
    await cp(desktop.logDir ?? join(desktop.dataDir, "logs"), join(evidence, "application-logs"), {
      recursive: true,
    });
  } catch (error) {
    report.logCollectionError = String(error);
  }
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(evidence);
}
