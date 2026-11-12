import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

export function checkLocalApiContract(fixture, floor) {
  assert.equal(fixture.schema.version, 1);
  const methods = new Map(fixture.schema.methods.map((method) => [method.name, method]));
  assert.equal(methods.size, fixture.schema.methods.length, "Duplicate local API method");
  assert.deepEqual(fixture.schema.transport, floor.transport, "Local protocol transport changed");
  assert.deepEqual(fixture.schema.errors, floor.errors, "Local protocol errors changed");
  const ajv = new Ajv({ allErrors: true, multipleOfPrecision: 8 });
  const covered = new Set();
  for (const method of floor.methods) {
    assert.deepEqual(
      methods.get(method.name),
      method,
      `Local API candidate contract changed: ${method.name}`,
    );
  }
  for (const sample of fixture.samples) {
    const method = methods.get(sample.method);
    assert.ok(method, "Sample has no discoverable method");
    for (const [key, schema] of [
      ["params", method.inputSchema],
      ["result", method.resultSchema],
    ]) {
      const validate = ajv.compile(schema);
      assert.ok(
        validate(sample[key]),
        `${sample.method} ${key}: ${JSON.stringify(validate.errors)}`,
      );
    }
    covered.add(sample.method);
  }
  assert.deepEqual(
    covered,
    new Set(methods.keys()),
    "Every method requires an actual producer sample",
  );
  return { methods: methods.size, samples: fixture.samples.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], "Pass the actual Rust local API fixture output");
  const [fixture, floor, preferences] = await Promise.all([
    readFile(process.argv[2], "utf8"),
    readFile(new URL("../../tests/fixtures/local-api/candidate-v1.json", import.meta.url), "utf8"),
    readFile(
      new URL("../../tests/fixtures/local-api/preferences-v1.json", import.meta.url),
      "utf8",
    ),
  ]);
  const expected = JSON.parse(floor);
  expected.methods.push(...JSON.parse(preferences).methods);
  console.log(JSON.stringify(checkLocalApiContract(JSON.parse(fixture), expected)));
}
