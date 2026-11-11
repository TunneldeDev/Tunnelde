import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";

const schema = JSON.parse(
  await readFile(
    new URL(
      "../../src-tauri/src/plugins/api/domains/storage/observation/schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
const request = ajv.compile({
  $schema: schema.$schema,
  definitions: schema.definitions,
  $ref: "#/definitions/request",
});

/** Structural producer gate. Safe numbers/depth/decoded limits are also checked by
 * the actual SDK; original Rust wire size is asserted by the native producer. */
export function checkStorageContract(fixture) {
  for (const value of [fixture.initial, fixture.idle, fixture.unicode, fixture.decimal]) {
    assert.equal(validate(value), true, "Storage producer violates its schema");
    assert(
      Buffer.byteLength(JSON.stringify(value)) <= 514 * 1024,
      "Storage decoded response exceeds its work bound",
    );
    if (value.changed) assert.equal(value.revision, value.snapshot.revision);
  }
  assert.equal(fixture.initial.changed, true);
  assert.equal(fixture.idle.changed, false);
  assert.equal(fixture.idle.revision, fixture.initial.revision);
  for (const value of [{}, { revision: fixture.initial.revision }])
    assert.equal(request(value), true);
  for (const value of [
    null,
    { revision: null },
    { revision: "" },
    { revision: "x\n" },
    { id: "other" },
    { path: "/" },
  ])
    assert.equal(request(value), false);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, sdk] = process.argv.slice(2);
  assert(fixturePath && sdk, "Expected native fixture and SDK directory");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  checkStorageContract(fixture);
  const { createStorageClient } = await import(
    pathToFileURL(join(resolve(sdk), "storage/client.mjs")).href
  );
  let response = fixture.initial;
  const client = createStorageClient({
    call: async (method) => {
      assert.equal(method, "storage.observe");
      return response;
    },
  });
  const first = await client.observe();
  assert.deepEqual(first, fixture.initial);
  response = fixture.idle;
  assert.deepEqual(await client.observe({ revision: first.revision }), fixture.idle);
  for (const name of ["unicode", "decimal"]) {
    response = fixture[name];
    assert.deepEqual(await client.observe(), response);
  }
  console.log(
    "Native storage observations satisfy machine schema and SDK, including decimal expansion.",
  );
}
