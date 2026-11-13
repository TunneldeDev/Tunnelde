import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stableBaseline } from "../contracts/local-api/baseline.mjs";
import { checkLocalApiContract, contractValidator } from "./check-local-api-contract.mjs";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../../tests/fixtures/local-api/${name}`, import.meta.url), "utf8"),
  );
const historical = {
  core: await load("candidate-v1.json"),
  preferences: await load("preferences-v1.json"),
  protocol: await load("protocol-v1.json"),
  discovery: await load("discovery-v1.json"),
};
const declaration = await load("stable-v1/declaration.json");
const discovery = await load("stable-v1/discovery.json");

test("finite stable declaration preserves every historical data/input/error field", () => {
  const original = globalThis.structuredClone(historical);
  const { floor, protocol } = stableBaseline(historical, discovery, declaration);
  assert.equal(floor.stability, "stable");
  assert.equal(protocol.stability, "stable");
  assert.equal(floor.methods.length, 7);
  for (const method of floor.methods) {
    assert.equal(method.stability, "stable");
    assert.equal(method.since, "0.38.0-beta.1");
  }
  const schema = floor.methods.find((m) => m.name === "preferences.schema");
  assert.equal(schema.resultSchema.properties.stability.const, "stable");
  assert.deepEqual(historical, original);
});

test("frozen historical fixtures, stable discovery and method scope cannot silently change", () => {
  for (const name of Object.keys(historical)) {
    const changed = globalThis.structuredClone(historical);
    changed[name].unexpected = true;
    assert.throws(
      () => stableBaseline(changed, discovery, declaration),
      /Historical .* baseline changed/,
    );
  }
  assert.throws(
    () => stableBaseline(historical, { ...discovery, unexpected: true }, declaration),
    /Stable discovery baseline changed/,
  );
  assert.throws(
    () =>
      stableBaseline(historical, discovery, {
        ...declaration,
        methods: declaration.methods.slice(1),
      }),
    /Stable method scope changed/,
  );
});

test("stable discovery requires method lifecycle metadata but tolerates future experimental methods", () => {
  const { floor, protocol } = stableBaseline(historical, discovery, declaration);
  const value = { ...floor, protocol };
  const validate = contractValidator().compile(discovery);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  const oldConsumer = contractValidator().compile(historical.discovery);
  assert.equal(oldConsumer(value), true, JSON.stringify(oldConsumer.errors));
  const future = globalThis.structuredClone(value);
  future.methods.push({
    name: "future.read",
    effect: "read",
    stability: "experimental",
    since: null,
    inputSchema: {},
    resultSchema: true,
  });
  assert.equal(validate(future), true, JSON.stringify(validate.errors));
  for (const field of ["stability", "since"]) {
    const missing = globalThis.structuredClone(value);
    delete missing.methods[0][field];
    assert.equal(validate(missing), false);
  }
  const bad = globalThis.structuredClone(value);
  bad.methods[0].stability = "unspecified";
  assert.equal(validate(bad), false);
});

test("producer validation rejects stability regression without weakening the frozen method", () => {
  const { floor } = stableBaseline(historical, discovery, declaration);
  const fixture = {
    schema: { ...globalThis.structuredClone(floor), stability: "experimental" },
    samples: [],
  };
  assert.throws(
    () => checkLocalApiContract(fixture, floor, discovery),
    /Local API stability changed/,
  );
});
