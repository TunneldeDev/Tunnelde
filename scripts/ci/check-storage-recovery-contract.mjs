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
      "../../src-tauri/src/plugins/api/domains/storage/recovery/schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true });
for (const [name, definition] of [
  ["initial", null],
  ["idle", null],
  ["request", "request"],
  ["scheduled", "requestResult"],
]) {
  const validate = ajv.compile(
    definition ? { definitions: schema.definitions, $ref: `#/definitions/${definition}` } : schema,
  );
  assert(validate(fixture[name]), JSON.stringify(validate.errors));
}
const { createHostStorageRecoveryClient } = await import(
  pathToFileURL(join(resolve(sdk), "storage/recovery/client.mjs")).href
);
let response = fixture.initial;
const client = createHostStorageRecoveryClient({ call: async () => response });
assert.deepEqual(await client.observe(), fixture.initial);
response = fixture.idle;
assert.deepEqual(await client.observe({ revision: fixture.initial.revision }), fixture.idle);
response = fixture.scheduled;
assert.deepEqual(await client.request(fixture.request), fixture.scheduled);
console.log("Actual native storage recovery satisfies machine schema and SDK.");
