import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

const [fixturePath, sdkPath] = process.argv.slice(2);
assert(fixturePath && sdkPath, "Expected actual frontend fixture and SDK directory");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const schema = JSON.parse(
  await readFile(
    new URL("../../src-tauri/src/plugins/api/domains/files/browser/schema.json", import.meta.url),
    "utf8",
  ),
);
const mirrored = JSON.parse(await readFile(join(sdkPath, "files/browser/schema.json"), "utf8"));
assert.deepEqual(mirrored, schema);
const { createFileBrowserClient } = await import(
  pathToFileURL(join(resolve(sdkPath), "files/browser/client.mjs")).href
);
const ajv = new Ajv({ allErrors: true });
const seen = new Set();
for (const sample of fixture.samples) {
  const shapes = schema.methods[sample.method];
  assert(shapes, `Unexpected method ${sample.method}`);
  for (const [shape, data] of [
    [shapes.inputSchema, sample.params],
    [shapes.resultSchema, sample.result],
  ]) {
    const validate = ajv.compile({ definitions: schema.definitions, ...shape });
    assert(validate(data), JSON.stringify(validate.errors));
  }
  let calls = 0;
  const client = createFileBrowserClient({
    call: async (method, params) => {
      assert.equal(method, sample.method);
      assert.deepEqual(params, sample.params);
      calls++;
      return sample.result;
    },
  });
  const action = sample.method.slice("fileBrowser.".length);
  assert.deepEqual(await client[action](sample.params), sample.result);
  assert.equal(calls, 1);
  seen.add(sample.method);
}
assert.deepEqual([...seen].sort(), Object.keys(schema.methods).sort());
assert(fixture.samples.some((sample) => sample.result.changed === false));
assert(
  fixture.samples.some(
    (sample) => sample.method === "fileBrowser.read" && sample.result.nextOffset !== null,
  ),
);
console.log(
  `Actual host browser bridge: ${fixture.samples.length} samples satisfy canonical schema and SDK.`,
);
