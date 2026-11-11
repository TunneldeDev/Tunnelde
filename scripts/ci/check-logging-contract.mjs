import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";

const schema = JSON.parse(
  await readFile(
    new URL("../../src-tauri/src/plugins/api/domains/logging/schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true }),
  validate = ajv.compile(schema);
const request = ajv.compile({
  $schema: schema.$schema,
  definitions: schema.definitions,
  $ref: "#/definitions/request",
});
export function checkLoggingContract(page) {
  assert.equal(validate(page), true, "Log producer violates its schema");
  assert(
    Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024,
    "Log page exceeds its response bound",
  );
  for (const value of [
    {},
    { source: "operations", limit: 1 },
    { filter: { domains: ["network"], levels: ["warn"] } },
  ])
    assert.equal(request(value), true);
  for (const value of [
    null,
    { source: null },
    { path: "/" },
    { cursor: null },
    { limit: 0 },
    { limit: 201 },
    { filter: { levels: ["WARN"] } },
    { filter: { domains: ["a", "a"] } },
  ])
    assert.equal(request(value), false);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, sdk] = process.argv.slice(2);
  assert(fixturePath && sdk, "Expected native fixture and SDK directory");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  checkLoggingContract(fixture);
  const { createLoggingClient } = await import(
    pathToFileURL(join(resolve(sdk), "logging/client.mjs")).href
  );
  assert.deepEqual(
    await createLoggingClient({
      call: async (method) => {
        assert.equal(method, "logs.read");
        return fixture;
      },
    }).read(),
    fixture,
  );
  console.log("Actual persisted native log projection satisfies schema and SDK.");
}
