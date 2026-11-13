import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { stableBaseline } from "../contracts/local-api/baseline.mjs";

export function contractValidator() {
  const ajv = new Ajv({ allErrors: true, multipleOfPrecision: 8 });
  ajv.addKeyword("x-maxBytes", {
    type: "string",
    schemaType: "number",
    validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit,
    errors: false,
  });
  return ajv;
}

export function checkProtocolSamples(fixture, floor) {
  assert.deepEqual(fixture.schema.protocol, floor, "Local protocol contract changed");
  const ajv = contractValidator();
  for (const sample of fixture.wireSamples) {
    for (const key of ["request", "response"]) {
      if (!(key in sample)) continue;
      const validate = ajv.compile(floor[`${key}Schema`]);
      assert.equal(
        validate(sample[key]),
        sample[`${key}Valid`] ?? true,
        `Wire ${key}: ${JSON.stringify(validate.errors)}`,
      );
    }
  }
  const errors = new Map(
    fixture.errorSamples.map((sample) => [sample.response.error.code, sample]),
  );
  const validate = ajv.compile(floor.responseSchema);
  for (const entry of floor.errors) {
    const sample = errors.get(entry.code);
    assert.ok(sample, `Missing actual error producer: ${entry.code}`);
    assert.equal(sample.exitCode, entry.exitCode, `Error exit code changed: ${entry.code}`);
    assert.ok(validate(sample.response), JSON.stringify(validate.errors));
  }
  assert.ok(fixture.wireSamples.length >= 6, "Missing actual wire regression samples");
  return { wireSamples: fixture.wireSamples.length, errorSamples: errors.size };
}

export function checkLocalApiContract(fixture, floor, discovery, historicalDiscovery) {
  assert.equal(fixture.schema.version, 1);
  assert.equal(fixture.schema.stability, floor.stability, "Local API stability changed");
  const methods = new Map(fixture.schema.methods.map((method) => [method.name, method]));
  assert.equal(methods.size, fixture.schema.methods.length, "Duplicate local API method");
  assert.deepEqual(fixture.schema.transport, floor.transport, "Local protocol transport changed");
  assert.deepEqual(fixture.schema.errors, floor.errors, "Local protocol errors changed");
  const ajv = contractValidator();
  const covered = new Set();
  for (const method of floor.methods) {
    const expected =
      method.name === "api.describe" && discovery ? { ...method, resultSchema: discovery } : method;
    assert.deepEqual(
      methods.get(method.name),
      expected,
      `Local API contract changed: ${method.name}`,
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
    // Historical producer snapshots stay immutable. Discovery is refined by a
    // separate baseline, while its result must still satisfy the old consumer.
    if (sample.method === "api.describe" && discovery) {
      const historical = floor.methods.find((entry) => entry.name === sample.method);
      assert.ok(
        ajv.validate(historicalDiscovery ?? historical.resultSchema, sample.result),
        "Historical discovery result",
      );
    }
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
  const [fixture, floor, preferences, protocol, discovery, stableDiscovery, declaration] =
    await Promise.all([
      readFile(process.argv[2], "utf8"),
      readFile(
        new URL("../../tests/fixtures/local-api/candidate-v1.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../tests/fixtures/local-api/preferences-v1.json", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../tests/fixtures/local-api/protocol-v1.json", import.meta.url), "utf8"),
      readFile(
        new URL("../../tests/fixtures/local-api/discovery-v1.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../tests/fixtures/local-api/stable-v1/discovery.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../tests/fixtures/local-api/stable-v1/declaration.json", import.meta.url),
        "utf8",
      ),
    ]);
  const stable = stableBaseline(
    {
      core: JSON.parse(floor),
      preferences: JSON.parse(preferences),
      protocol: JSON.parse(protocol),
      discovery: JSON.parse(discovery),
    },
    JSON.parse(stableDiscovery),
    JSON.parse(declaration),
  );
  const actual = JSON.parse(fixture);
  console.log(
    JSON.stringify({
      ...checkLocalApiContract(
        actual,
        stable.floor,
        JSON.parse(stableDiscovery),
        JSON.parse(discovery),
      ),
      ...checkProtocolSamples(actual, stable.protocol),
    }),
  );
}
