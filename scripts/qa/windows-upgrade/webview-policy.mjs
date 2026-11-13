import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const prefix = "HKLM\\Software\\Policies\\Microsoft\\Edge\\WebView2\\";

// Hosted Windows runners are elevated. WebView2 >=150 intentionally ignores
// user-scoped debugging overrides in elevated processes. Use the documented
// machine policy on this disposable runner only, without changing the product.
// https://learn.microsoft.com/microsoft-edge/webview2/concepts/security
export class WebViewPolicy {
  owned = [];

  async set(name, value) {
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
    assert(["AdditionalBrowserArguments", "UserDataFolder"].includes(name));
    const key = prefix + name;
    const existing = await run("reg.exe", ["query", key, "/v", "tunnelde.exe"]).then(
      () => true,
      () => false,
    );
    assert.equal(existing, false, "Refusing to overwrite an existing app policy");
    await run("reg.exe", ["add", key, "/v", "tunnelde.exe", "/t", "REG_SZ", "/d", value, "/f"]);
    this.owned.push(key);
  }

  async clear() {
    for (const key of [...this.owned].reverse()) {
      await run("reg.exe", ["delete", key, "/v", "tunnelde.exe", "/f"]);
      this.owned.splice(this.owned.indexOf(key), 1);
    }
  }
}
