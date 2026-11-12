import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";

const [fixturePath, sdkPath] = process.argv.slice(2);
assert(fixturePath && sdkPath, "Expected native content fixture and SDK");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const schema = JSON.parse(
  await readFile(
    new URL("../../src-tauri/src/plugins/files/content/schema.json", import.meta.url),
    "utf8",
  ),
);
assert.deepEqual(
  JSON.parse(await readFile(join(sdkPath, "files/content/schema.json"), "utf8")),
  schema,
);
const { prepared, observation, bytes, closed } = await import(
  pathToFileURL(join(resolve(sdkPath), "files/content/data/reply.mjs"))
);
const ajv = new Ajv({ allErrors: true }),
  seen = new Set();
let size;
for (const sample of fixture.samples) {
  const shape = schema.methods[sample.method];
  assert(shape);
  for (const [description, value] of [
    [shape.inputSchema, sample.params],
    [shape.resultSchema, sample.result],
  ]) {
    const validate = ajv.compile(description);
    assert(validate(value), JSON.stringify(validate.errors));
  }
  const id = sample.params.contentId;
  switch (sample.method) {
    case "files.content.prepare":
      prepared(sample.result);
      break;
    case "files.content.open":
      size = observation(sample.result, id, true).size;
      break;
    case "files.content.read": {
      const actual = bytes(sample.result, id, sample.params, size);
      assert(actual.every((value, index) => value === (sample.params.offset + index) % 251));
      break;
    }
    case "files.content.observe":
      observation(sample.result, id);
      break;
    case "files.content.close":
      closed(sample.result);
      break;
    default:
      assert.fail(sample.method);
  }
  seen.add(sample.method);
}
assert.deepEqual([...seen].sort(), Object.keys(schema.methods).sort());
assert(fixture.samples.some((v) => v.method === "files.content.read" && v.result.bytes === 49152));
assert(
  fixture.samples.some(
    (v) => v.method === "files.content.read" && v.result.bytes === 0 && v.result.eof,
  ),
);
assert(
  fixture.samples.some((v) => v.method === "files.content.observe" && v.result.state === "closed"),
);
console.log(
  `Actual native content: ${fixture.samples.length} samples satisfy canonical schema and SDK.`,
);
