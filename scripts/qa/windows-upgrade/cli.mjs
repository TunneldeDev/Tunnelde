import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);

export async function verifyCli(binary, version, root, hostId) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const call = async (...args) => {
    const { stdout, stderr } = await run(binary, ["cli", ...args], {
      timeout: 15000,
      windowsHide: true,
      env,
      maxBuffer: 5 * 1024 * 1024,
    });
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  };
  assert.equal((await call("--version")).version, version);
  const offline = await call("api", "describe");
  const live = async (...args) => {
    const response = await call("--endpoint", join(root, "data", "automation.json"), ...args);
    assert.equal(response.version, 1);
    assert.equal(typeof response.id, "string");
    assert(response.id.length > 0);
    assert(!response.error, JSON.stringify(response.error));
    return response.result;
  };
  assert.deepEqual(await live("call", "api.describe"), offline);
  assert.equal((await live("app", "info")).version, version);
  assert((await live("hosts", "list")).hosts.some((host) => host.id === hostId));
  assert(Array.isArray((await live("sessions", "list")).sessions));
  const schema = await live("preferences", "schema");
  assert.equal(schema.version, 1);
  const before = await live("preferences", "snapshot");
  const changed = await live(
    "preferences",
    "update",
    "--params",
    JSON.stringify({
      revision: before.revision,
      changes: { editor: { tabSize: 8 } },
    }),
  );
  assert.equal(changed.values.editor.tabSize, 8);
  assert.deepEqual(await live("preferences", "snapshot"), changed);
  await live(
    "preferences",
    "update",
    "--params",
    JSON.stringify({
      revision: changed.revision,
      changes: { editor: { tabSize: before.values.editor.tabSize } },
    }),
  );
}
