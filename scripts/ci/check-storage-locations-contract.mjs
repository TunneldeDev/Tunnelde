import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

const [fixturePath, sdk] = process.argv.slice(2);
assert(fixturePath && sdk, "Expected native fixture and SDK directory");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const schema = JSON.parse(
  await readFile(
    new URL(
      "../../src-tauri/src/plugins/api/domains/storage/locations/schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
for (const name of ["initial", "idle"])
  assert(validate(fixture[name]), JSON.stringify(validate.errors));
for (const [name, definition] of [
  ["scheduleRequest", "scheduleRequest"],
  ["cancelRequest", "cancelRequest"],
  ["scheduled", "changeResult"],
  ["cancelled", "changeResult"],
]) {
  const check = ajv.compile({
    definitions: schema.definitions,
    $ref: `#/definitions/${definition}`,
  });
  assert(check(fixture[name]), JSON.stringify(check.errors));
}
const { createHostStorageClient } = await import(
  pathToFileURL(join(resolve(sdk), "storage/locations/client.mjs")).href
);
let response = fixture.initial;
const client = createHostStorageClient({ call: async () => response });
assert.deepEqual(await client.observe(), fixture.initial);
response = fixture.idle;
assert.deepEqual(await client.observe({ revision: fixture.initial.revision }), fixture.idle);
response = fixture.scheduled;
assert.deepEqual(await client.schedule(fixture.scheduleRequest), fixture.scheduled);
response = fixture.cancelled;
assert.deepEqual(await client.cancel(fixture.cancelRequest), fixture.cancelled);
console.log("Actual native storage locations satisfy the machine schema and SDK.");
