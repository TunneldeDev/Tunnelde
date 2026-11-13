import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stableBaseline } from "../../contracts/local-api/baseline.mjs";

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../tests/fixtures/local-api/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const { floor, protocol } = stableBaseline(
  {
    core: fixture("candidate-v1"),
    preferences: fixture("preferences-v1"),
    protocol: fixture("protocol-v1"),
    discovery: fixture("discovery-v1"),
  },
  fixture("stable-v1/discovery"),
  fixture("stable-v1/declaration"),
);

// Pre-1.0 public packages remain usable as upgrade sources. From the first 1.0
// candidate onward the packaged producer must retain the reviewed stable floor.
export function verifyPackagedContract(schema, version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9])?$/);
  if (version.startsWith("0.")) return { stableFloorVerified: false };
  for (const key of ["version", "stability", "transport", "errors"])
    assert.deepEqual(schema[key], floor[key], `Packaged local ${key} changed`);
  assert.deepEqual(schema.protocol, protocol, "Packaged local protocol changed");
  const methods = new Map(schema.methods.map((method) => [method.name, method]));
  assert.equal(methods.size, schema.methods.length, "Duplicate packaged local method");
  for (const method of floor.methods)
    assert.deepEqual(
      methods.get(method.name),
      method,
      `Packaged local contract changed: ${method.name}`,
    );
  return { stableFloorVerified: true, stableMethods: floor.methods.map((method) => method.name) };
}
