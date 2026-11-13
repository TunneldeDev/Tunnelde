import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function applicationEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "TUNNELDE_ENDPOINT"]) delete env[name];
  return env;
}

export async function offlineCli(binary, version, env = applicationEnvironment()) {
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
  const schema = await call("api", "describe");
  assert.equal(schema.version, 1);
  return { call, schema };
}

export async function verifyLocalCli(binary, version, pointer, options = {}) {
  const { call, schema } = await offlineCli(binary, version, options.env);
  const args = ["--endpoint", pointer];
  const live = async (...command) => {
    const response = await call(...args, ...command);
    assert.equal(response.version, 1);
    assert.equal(typeof response.id, "string");
    assert(response.id.length > 0);
    assert(!response.error, JSON.stringify(response.error));
    return response.result;
  };
  assert.deepEqual(await live("call", "api.describe"), schema);
  assert.equal((await live("app", "info")).version, version);
  const hosts = (await live("hosts", "list")).hosts;
  assert(Array.isArray(hosts));
  if (options.hostId) assert(hosts.some((host) => host.id === options.hostId));
  assert(Array.isArray((await live("sessions", "list")).sessions));
  assert.equal((await live("preferences", "schema")).version, 1);
  const before = await live("preferences", "snapshot");
  const tabSize = before.values.editor.tabSize === 8 ? 4 : 8;
  const changed = await live(
    "preferences",
    "update",
    "--params",
    JSON.stringify({ revision: before.revision, changes: { editor: { tabSize } } }),
  );
  assert.equal(changed.values.editor.tabSize, tabSize);
  assert.notEqual(changed.revision, before.revision);
  assert.deepEqual(await live("preferences", "snapshot"), changed);
  try {
    await call(
      ...args,
      "preferences",
      "update",
      "--params",
      JSON.stringify({ revision: before.revision, changes: { editor: { tabSize: 2 } } }),
    );
    assert.fail("A stale write must fail");
  } catch (error) {
    assert.equal(error.code, 5, "Stale revision must use exit 5");
    assert.equal(JSON.parse(error.stderr).error.code, "stale_revision");
  }
  assert.deepEqual(await live("preferences", "snapshot"), changed);
  const restored = await live(
    "preferences",
    "update",
    "--params",
    JSON.stringify({
      revision: changed.revision,
      changes: { editor: { tabSize: before.values.editor.tabSize } },
    }),
  );
  assert.deepEqual(restored.values, before.values);
  return {
    methods: schema.methods.map((method) => method.name),
    staleWriteRejected: true,
    preferencesRestored: true,
  };
}
