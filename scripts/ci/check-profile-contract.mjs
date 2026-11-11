import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";

const schema = JSON.parse(
  await readFile(
    new URL("../../src-tauri/src/settings_profiles/observation/schema.json", import.meta.url),
    "utf8",
  ),
);
const validate = new Ajv({ allErrors: true }).compile(schema);

export function checkProfileContract(fixture) {
  for (const value of [fixture.initial, fixture.idle]) {
    assert.equal(validate(value), true, "Profile producer violates its schema");
    assert(
      Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024,
      "Profile response exceeds its bound",
    );
  }
  assert.equal(fixture.initial.changed, true);
  assert.equal(fixture.idle.changed, false);
  assert.equal(fixture.initial.revision, fixture.initial.snapshot.revision);
  assert.equal(fixture.idle.revision, fixture.initial.revision);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, sdk] = process.argv.slice(2);
  assert(fixturePath && sdk, "Expected native fixture and SDK directory");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  checkProfileContract(fixture);
  const { createProfilesClient } = await import(
    pathToFileURL(join(resolve(sdk), "profiles/client.mjs")).href
  );
  let response = fixture.initial;
  const client = createProfilesClient({
    call: async (method) => {
      assert.equal(method, "profiles.observe");
      return response;
    },
  });
  const first = await client.observe();
  assert.deepEqual(first, fixture.initial);
  response = fixture.idle;
  assert.deepEqual(await client.observe({ revision: first.revision }), fixture.idle);
  console.log("Native profile observations satisfy the machine schema and SDK consumer.");
}
