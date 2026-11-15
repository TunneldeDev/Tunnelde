import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, writeFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { join } from "node:path";
import { observeUpdateProgress } from "./progress.mjs";

const run = promisify(execFile);

// Only called by the guarded hosted-runner harness. Enumerate/stop exclusively
// the executable installed by this run, never a workstation's existing app.
async function installedProcesses(binary, stop = false) {
  const env = { ...process.env, QA_OTA_BINARY: binary };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const script =
    "$p = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:QA_OTA_BINARY }); " +
    (stop
      ? "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "
      : "") +
    "ConvertTo-Json -Compress -InputObject @($p | ForEach-Object { $_.ProcessId })";
  const { stdout } = await run("pwsh", ["-NoProfile", "-Command", script], { env, timeout: 15000 });
  return JSON.parse(stdout);
}

export async function updateInApplication(desktop, binary, tag, report) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert(binary.startsWith(join(desktop.root, "installed")));
  await desktop.invoke("settings_update", {
    patch: {
      updateChannel: tag.includes("-beta.") ? "beta" : "stable",
      updateSource: "github",
      updateSourceUrl: "",
    },
  });
  const selected = await desktop.invoke("update_check", { force: true });
  assert.equal(selected.version, tag.slice(1));
  assert.equal(selected.phase, "available");
  assert.equal(selected.autoInstall, true);
  report.updateSelection = selected;
  await writeFile(
    join(desktop.root, "evidence", "update-selection.json"),
    JSON.stringify(selected, null, 2),
  );
  const progress = (report.updateProgress = []);
  await observeUpdateProgress(desktop.page, progress);
  let installError;
  const install = desktop.invoke("update_install").catch((error) => {
    installError = String(error);
  });
  const until = Date.now() + 180000;
  while (desktop.child.exitCode === null && Date.now() < until) {
    await pause(250);
  }
  assert.notEqual(
    desktop.child.exitCode,
    null,
    `Updater did not exit the old app: ${installError}`,
  );
  const exit = await desktop.done;
  assert.equal(exit.code, 0, JSON.stringify(exit));
  report.exits.push({ version: desktop.version, stage: "updater-handoff", ...exit });
  // Closing the old WebView rejects a pending invocation; it is not an updater error.
  await desktop.browser?.close().catch(() => {});
  await install;
  desktop.browser = null;
  desktop.page = null;
  desktop.child = null;
  report.checks.push(
    "Application update_check selected the exact public signed target and update_install handed off with exit 0",
  );
  await desktop.connect(tag.slice(1), 120000);
  const processes = await installedProcesses(binary);
  assert.equal(processes.length, 1, "Updater must restart the installed target exactly once");
  report.restartedPid = processes[0];
  report.checks.push(
    "Updater restarted the target installed binary without an explicit harness launch",
  );
}

export async function quitUpdated(desktop, binary, report) {
  await desktop.invoke("plugin:window|close", { label: "main" }).catch(() => {});
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const running = await installedProcesses(binary);
    const pointerExists = await access(join(desktop.dataDir, "automation.json")).then(
      () => true,
      () => false,
    );
    if (!running.length && !pointerExists) {
      report.exits.push({
        version: desktop.version,
        normalQuitObserved: true,
        evidence:
          "Window-close command, installed process gone and automation endpoint removed; non-child exit code unavailable",
      });
      await desktop.browser?.close().catch(() => {});
      desktop.browser = null;
      desktop.page = null;
      await desktop.policy.clear();
      return;
    }
    await pause(250);
  }
  throw Error("Updated application did not quit and remove its endpoint");
}

export async function cleanupUpdated(binary) {
  await installedProcesses(binary, true);
}
