import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { join, resolve } from "node:path";
import { WebViewPolicy } from "./webview-policy.mjs";

export class Desktop {
  constructor(chromium, root, report) {
    Object.assign(this, { chromium, root, report });
    this.policy = new WebViewPolicy();
    this.dataDir = join(root, "data");
  }

  async start(binary, version) {
    this.binary = binary;
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.TUNNELDE_PLUGINS_DIR;
    if (this.nativeProfile) delete env.TUNNELDE_DATA_DIR;
    else env.TUNNELDE_DATA_DIR = this.dataDir;
    Object.assign(env, {
      WEBVIEW2_USER_DATA_FOLDER: join(this.root, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    });
    this.port = port;
    await this.policy.set("AdditionalBrowserArguments", `--remote-debugging-port=${port}`);
    await this.policy.set("UserDataFolder", join(this.root, "webview"));
    this.child = spawn(binary, [], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    this.done = new Promise((resolve) => {
      this.child.once("error", (error) => resolve({ error: String(error) }));
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.child.stdout.pipe(createWriteStream(join(this.root, "evidence", `${version}-stdout.log`)));
    this.child.stderr.pipe(createWriteStream(join(this.root, "evidence", `${version}-stderr.log`)));
    await this.connect(version);
  }

  async connect(version, timeout = 60000) {
    const until = Date.now() + timeout;
    let lastError;
    while (Date.now() < until) {
      if (this.child) assert.equal(this.child.exitCode, null, "Desktop exited before readiness");
      try {
        this.browser = await this.chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, {
          timeout: 1000,
        });
        this.page = this.browser
          .contexts()[0]
          .pages()
          .find((page) => page.url().includes("tauri.localhost"));
        assert(this.page, "Main WebView is not ready");
        await this.page.locator(".app").waitFor({ timeout: 1000 });
        assert.equal((await this.invoke("app_info")).version, version);
        break;
      } catch (error) {
        lastError = error;
        await this.browser?.close().catch(() => {});
        this.browser = null;
        await pause(200);
      }
    }
    assert(this.browser && this.page, `WebView readiness failed: ${lastError}`);
    this.page.on("pageerror", (error) => this.report.pageErrors.push(String(error)));
    this.version = version;
    const storage = await this.invoke("storage_status");
    const paths = Object.fromEntries(
      storage.locations.map(({ category, path }) => [category, path]),
    );
    assert.equal(
      resolve(paths.database).toLowerCase(),
      resolve(this.dataDir).toLowerCase(),
      "The source and automatically restarted target must use the same data directory",
    );
    this.logDir = paths.logs;
    (this.report.storageLocations ??= []).push({ version, paths });
  }

  invoke(cmd, args = {}) {
    return this.page.evaluate(
      async ({ cmd, args }) => {
        try {
          return await globalThis.__TAURI_INTERNALS__.invoke(cmd, args);
        } catch (error) {
          throw Error(error?.message ?? JSON.stringify(error));
        }
      },
      { cmd, args },
    );
  }

  call(method, params) {
    return this.page.evaluate(
      ({ method, params }) => globalThis.__qaUpgrade.api.call(method, params),
      { method, params },
    );
  }

  async activate(plugin) {
    if (await this.page.evaluate(() => !!globalThis.__qaUpgrade)) return;
    const permit = await this.invoke("plugin_prepare_start", {
      id: plugin.id,
      expectedFingerprint: plugin.fingerprint,
    });
    await this.invoke("plugin_start", { id: plugin.id, permit });
    await this.page.waitForFunction(() => !!globalThis.__qaUpgrade, null, { timeout: 15000 });
  }

  async quit() {
    await this.invoke("plugin:window|close", { label: "main" }).catch(() => {});
    const exit = await Promise.race([
      this.done,
      pause(15000).then(() => {
        throw Error("Normal application quit timed out");
      }),
    ]);
    assert.equal(exit.code, 0, JSON.stringify(exit));
    this.report.exits.push({ version: this.version, ...exit });
    this.child = null;
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.page = null;
    await this.policy.clear();
  }

  async cleanup() {
    if (this.port) {
      const command =
        "$ErrorActionPreference='Continue'; " +
        "$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'tunnelde|msedgewebview2|explorer' } | Select-Object ProcessId,ParentProcessId,SessionId,Name,ExecutablePath,CommandLine); " +
        "$windows = @(Get-Process | Where-Object { $_.ProcessName -match 'tunnelde|explorer' } | Select-Object Id,SessionId,ProcessName,MainWindowTitle); " +
        "$ports = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq [int]$env:QA_WEBVIEW_PORT } | Select-Object LocalAddress,LocalPort,OwningProcess); " +
        "$installed = if (Test-Path -LiteralPath $env:QA_INSTALLED_BINARY) { (Get-Item -LiteralPath $env:QA_INSTALLED_BINARY).VersionInfo | Select-Object FileName,FileVersion,ProductVersion }; " +
        "[PSCustomObject]@{ processes=$processes; windows=$windows; ports=$ports; installed=$installed } | ConvertTo-Json -Depth 4";
      const env = {
        ...process.env,
        QA_WEBVIEW_PORT: String(this.port),
        QA_INSTALLED_BINARY: this.binary,
      };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      const diagnostic = await promisify(execFile)("pwsh", ["-NoProfile", "-Command", command], {
        env,
        timeout: 10000,
      }).catch((error) => ({ stdout: String(error) }));
      await writeFile(join(this.root, "evidence", "processes.txt"), diagnostic.stdout);
    }
    if (this.page)
      await this.page
        .screenshot({ path: join(this.root, "evidence", "failure.png") })
        .catch(() => {});
    await this.browser?.close().catch(() => {});
    if (this.child?.exitCode === null) {
      this.child.kill();
      await Promise.race([this.done, pause(5000)]);
    }
    await this.policy.clear();
  }
}
