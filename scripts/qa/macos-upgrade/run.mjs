import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applicationEnvironment } from "../local-cli/verify.mjs";
import { packagedAsset } from "../local-cli/assets.mjs";
import { repository } from "../windows-upgrade/assets.mjs";
import { checkedDirectory, hostedContext, requireCapabilities } from "./guard.mjs";

const run = promisify(execFile);
const user = userInfo();
// Refuse before creating files, invoking native APIs or accessing releases.
const context = hostedContext({
  env: process.env,
  platform: process.platform,
  architecture: process.arch,
  user,
  home: homedir(),
  cwd: process.cwd(),
});
for (const path of [context.home, context.workspace, context.temp]) {
  await checkedDirectory(path, user.uid);
}
const source = dirname(fileURLToPath(import.meta.url));
assert.equal(await realpath(source), join(context.workspace, "scripts/qa/macos-upgrade"));
await mkdir(context.root, { mode: 0o700 }); // Never reuse or remove a prior run.
const evidence = join(context.root, "evidence");
await mkdir(evidence, { mode: 0o700 });
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  mode: "capability-probe-only",
  otaAttempted: false,
  otaAccepted: false,
  head: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  paths: context,
  from: process.env.UPGRADE_FROM,
  to: process.env.UPGRADE_TO,
  checks: [],
  commands: [],
  cleanup:
    "No application or service started; bounded helper commands awaited; files retained for runner disposal.",
};

async function command(name, executable, args, options = {}) {
  const entry = { name, executable, args };
  report.commands.push(entry);
  try {
    const result = await run(executable, args, {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: applicationEnvironment(),
      ...options,
    });
    Object.assign(entry, { exitCode: 0, stdout: result.stdout, stderr: result.stderr });
    return result.stdout;
  } catch (error) {
    Object.assign(entry, {
      exitCode: error.code ?? null,
      signal: error.signal ?? null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    });
    throw error;
  }
}

try {
  const actualHead = (await command("checkout-head", "/usr/bin/git", ["rev-parse", "HEAD"])).trim();
  assert.equal(actualHead, report.head, "Checkout does not match the dispatched head");
  assert.equal(
    await command("checkout-status", "/usr/bin/git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]),
    "",
    "Probe requires an unchanged checkout",
  );
  report.os = (await command("os-version", "/usr/bin/sw_vers", [])).trim();
  report.sourceFiles = {};
  for (const name of ["guard.mjs", "run.mjs", "probe.m"]) {
    report.sourceFiles[name] = createHash("sha256")
      .update(await readFile(join(source, name)))
      .digest("hex");
  }
  const nativeSource = join(source, "probe.m");
  report.probeSourceSha256 = createHash("sha256")
    .update(await readFile(nativeSource))
    .digest("hex");
  const binary = join(context.root, "probe");
  await command("compile-native-probe", "/usr/bin/xcrun", [
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
    "SystemConfiguration",
    nativeSource,
    "-o",
    binary,
  ]);
  report.probeBinarySha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const native = await command("native-capabilities", binary, []);
  await writeFile(join(evidence, "native.json"), native, { mode: 0o600 });
  report.native = JSON.parse(native);
  requireCapabilities(report.native);
  report.checks.push(
    "Console desktop, display, Accessibility and screen-capture preflight available",
  );
  const screenshot = join(evidence, "desktop.png");
  await command("capture-disposable-desktop", "/usr/sbin/screencapture", ["-x", screenshot]);
  const png = await readFile(screenshot);
  assert(png.length > 24 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  report.screenshot = { bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
  report.releases = [];
  for (const tag of [report.from, report.to]) {
    // Only gh receives the workflow's read-only token. No application is started.
    const stdout = await command(
      "public-release-metadata",
      "gh",
      ["api", `repos/${repository}/releases/tags/${tag}`],
      { timeout: 45000, env: process.env },
    );
    const release = JSON.parse(stdout);
    const asset = packagedAsset(release, tag, "darwin", process.arch);
    assert.equal(release.prerelease, false);
    report.releases.push({ tag, publishedAt: release.published_at, asset });
  }
  report.checks.push(
    "Exact public release pair and architecture metadata selected (not downloaded or verified)",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  // release metadata contains no credentials; never serialize the environment.
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      otaAccepted: false,
      evidence: resolve(evidence),
      failure: report.failure,
    }),
  );
}
