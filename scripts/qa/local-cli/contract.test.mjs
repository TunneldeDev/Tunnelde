import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stableBaseline } from "../../contracts/local-api/baseline.mjs";
import { verifyPackagedContract } from "./contract.mjs";

const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../tests/fixtures/local-api/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const { floor, protocol } = stableBaseline(
  {
    core: read("candidate-v1"),
    preferences: read("preferences-v1"),
    protocol: read("protocol-v1"),
    discovery: read("discovery-v1"),
  },
  read("stable-v1/discovery"),
  read("stable-v1/declaration"),
);
const discovery = () => globalThis.structuredClone({ ...floor, protocol });

test("1.0 stable and Beta packages require the frozen local contract", () => {
  for (const version of ["1.0.0-beta.1", "1.0.0", "1.1.0", "2.0.0"])
    assert.equal(verifyPackagedContract(discovery(), version).stableFloorVerified, true);
  assert.deepEqual(verifyPackagedContract(read("candidate-v1"), "0.38.0"), {
    stableFloorVerified: false,
  });
  assert.deepEqual(verifyPackagedContract(read("candidate-v1"), "0.38.0-beta.2"), {
    stableFloorVerified: false,
  });
  for (const version of ["1.0.0\n", "v1.0.0", "01.0.0", "1.0.0-beta.10", "1.0.0-nightly"])
    assert.throws(() => verifyPackagedContract(discovery(), version));
});

test("packaged acceptance rejects missing, downgraded and reinterpreted contracts", () => {
  const mutations = [
    (schema) => {
      schema.stability = "experimental";
    },
    (schema) => {
      schema.version = 2;
    },
    (schema) => {
      schema.methods.pop();
    },
    (schema) => {
      schema.methods.push(globalThis.structuredClone(schema.methods[0]));
    },
    (schema) => {
      schema.methods[0].stability = "experimental";
    },
    (schema) => {
      schema.methods[1].inputSchema.required = ["newRequiredField"];
    },
    (schema) => {
      schema.methods[1].resultSchema = {};
    },
    (schema) => {
      schema.methods[2].since = "1.0.0";
    },
    (schema) => {
      schema.protocol.stability = "experimental";
    },
    (schema) => {
      schema.protocol.errors[0].exitCode = 99;
    },
    (schema) => {
      schema.transport.maximumRequestBytes = 1;
    },
  ];
  for (const mutate of mutations) {
    const schema = discovery();
    mutate(schema);
    assert.throws(() => verifyPackagedContract(schema, "1.0.0-beta.1"));
  }
});

test("experimental additions and method reordering do not replace the stable floor", () => {
  const schema = discovery();
  schema.methods.reverse();
  schema.methods.push({ name: "future.experimental", stability: "experimental" });
  assert.equal(verifyPackagedContract(schema, "1.0.0").stableMethods.length, 7);
});
