import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";

const responsePath = process.argv[2];
assert.ok(responsePath, "Pass the response emitted by emit_discovery_contract_response");
const schema = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/api-describe-v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const requestSchema = JSON.parse(
  await readFile(
    new URL(
      "../../tests/fixtures/plugin-compat/api-describe-v1-request.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const response = JSON.parse(await readFile(responsePath, "utf8"));
const ajv = new Ajv({ allErrors: true });
const validateRequest = ajv.compile(requestSchema);
assert.equal(validateRequest({}), true, "An empty parameter object must be accepted");
assert.equal(validateRequest({ future: true }), true, "Additional parameters remain accepted");
assert.equal(validateRequest([]), false, "Parameters must be an object");
const validate = ajv.compile(schema);
assert.ok(validate(response), `Host discovery violates v1: ${JSON.stringify(validate.errors)}`);
const discovery = response.methods.find((method) => method.name === "api.describe");
assert.ok(discovery, "Stable api.describe method was removed");
assert.deepEqual(discovery.permissions, []);
assert.equal(discovery.params, "{}");
assert.equal(discovery.stability, "stable");
assert.equal(discovery.since, "0.21.0");
assert.equal(discovery.deprecated, null);

// Check the checker too: breaking changes fail while permitted additions pass.
const clone = () => JSON.parse(JSON.stringify(response));
const missing = clone();
delete missing.methods[0].permissions;
assert.equal(validate(missing), false, "Missing legacy fields must fail");
const wrongType = clone();
wrongType.methods[0].name = 1;
assert.equal(validate(wrongType), false, "Changed legacy field types must fail");
const additive = clone();
additive.extra = true;
additive.methods[0].newField = {};
additive.methods[0].stability = "future-state";
assert.equal(
  validate(additive),
  true,
  "Additive fields and future stability values are compatible",
);
console.log(`Validated ${response.methods.length} host methods against the v1 discovery contract.`);
