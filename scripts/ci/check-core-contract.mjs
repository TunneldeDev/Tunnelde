import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

export function checkCoreContracts(discovery, responses, floor) {
  assert.equal(floor.version, 1);
  const methods = new Map(discovery.methods.map((method) => [method.name, method]));
  const ajv = new Ajv({ allErrors: true });
  const validators = new Map();
  for (const [name, contract] of Object.entries(floor.methods)) {
    const method = methods.get(name);
    assert.ok(method, `Stable method removed: ${name}`);
    assert.equal(method.stability, "stable", `Stability changed: ${name}`);
    assert.equal(method.since, "0.21.0", `Availability changed: ${name}`);
    assert.deepEqual(method.permissions, name === "sessions.list" ? ["sessions.read"] : []);
    assert.deepEqual(method.contract, contract, `Frozen v1 contract changed: ${name}`);
  }
  for (const method of methods.values()) {
    assert.equal(
      !!method.contract,
      method.stability === "stable",
      `${method.name}: contract/stability mismatch`,
    );
    if (!method.contract) continue;
    assert.equal(method.contract.version, 1);
    const compiled = {};
    for (const kind of ["inputSchema", "resultSchema", "errorSchema"]) {
      assert.ok(ajv.validateSchema(method.contract[kind]), `${method.name}: invalid ${kind}`);
      compiled[kind] = ajv.compile(method.contract[kind]);
    }
    if (Object.hasOwn(method.contract, "commandContextSchema")) {
      assert.ok(
        ajv.validateSchema(method.contract.commandContextSchema),
        `${method.name}: invalid commandContextSchema`,
      );
      compiled.commandContextSchema = ajv.compile(method.contract.commandContextSchema);
    }
    validators.set(method.name, compiled);
  }
  const coverage = new Map();
  for (const sample of responses.samples) {
    const compiled = validators.get(sample.method);
    assert.ok(compiled, `Sample references non-stable method ${sample.method}`);
    const inputValid = compiled.inputSchema(sample.params);
    assert.equal(
      inputValid,
      sample.inputValid ?? true,
      `${sample.method}: request schema disagrees with host sample`,
    );
    const failed = Object.hasOwn(sample, "error");
    assert.notEqual(
      failed,
      Object.hasOwn(sample, "result"),
      `${sample.method}: expected exactly one result or error`,
    );
    const validate = compiled[failed ? "errorSchema" : "resultSchema"];
    assert.ok(
      validate(failed ? sample.error : sample.result),
      `${sample.method}: ${JSON.stringify(validate.errors)}`,
    );
    if (!failed) assert.ok(inputValid, `${sample.method}: successful input rejected by schema`);
    const kinds = coverage.get(sample.method) ?? new Set();
    kinds.add(failed ? "error" : "result");
    if (Object.hasOwn(sample, "commandInput")) {
      assert.ok(!failed && compiled.commandContextSchema, `${sample.method}: unexpected command`);
      assert.ok(
        compiled.commandContextSchema(sample.commandInput),
        `${sample.method}: ${JSON.stringify(compiled.commandContextSchema.errors)}`,
      );
      kinds.add("command");
    }
    coverage.set(sample.method, kinds);
  }
  for (const [name, compiled] of validators) {
    assert.deepEqual(
      coverage.get(name),
      new Set(["result", "error", ...(compiled.commandContextSchema ? ["command"] : [])]),
      `${name}: missing real result/error samples`,
    );
  }
  return { methods: validators.size, samples: responses.samples.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [discoveryPath, responsesPath] = process.argv.slice(2);
  assert.ok(
    discoveryPath && responsesPath,
    "Pass emitted discovery and core contract response paths",
  );
  const floorPath = new URL("../../tests/fixtures/plugin-compat/core-v1.json", import.meta.url);
  const [discovery, responses, floor] = await Promise.all(
    [discoveryPath, responsesPath, floorPath].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  const result = checkCoreContracts(discovery, responses, floor);
  console.log(
    `Validated ${result.samples} host samples against ${result.methods} stable core contracts.`,
  );
}
