import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { join } from "node:path";
import { WebViewPolicy } from "./webview-policy.mjs";

export class Desktop {
  constructor(chromium, root, report) {
    Object.assign(this, { chromium, root, report });
    this.policy = new WebViewPolicy();
  }

  async start(binary, version) {
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    Object.assign(env, {
      TUNNELDE_DATA_DIR: join(this.root, "data"),
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
    this.version = version;
    const until = Date.now() + 60000;
    let lastError;
    while (Date.now() < until) {
      assert.equal(this.child.exitCode, null, "Desktop exited before readiness");
      try {
        this.browser = await this.chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 1000,
        });
        this.page = this.browser
          .contexts()[0]
          .pages()
          .find((page) => page.url().includes("tauri.localhost"));
        assert(this.page, "Main WebView is not ready");
        await this.page.locator(".app").waitFor({ timeout: 1000 });
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
    assert.equal((await this.invoke("app_info")).version, version);
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
    if (this.child) {
      const command =
        "$ErrorActionPreference='Continue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'tunnelde|msedgewebview2' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3; Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq " +
        this.port +
        " } | ConvertTo-Json";
      const diagnostic = await promisify(execFile)("pwsh", ["-NoProfile", "-Command", command], {
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
