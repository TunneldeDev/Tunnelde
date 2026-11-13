import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function baselineDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Historical producer fixtures remain immutable. Promotion changes only the
// reviewed stability metadata and discovery schema, never input/data semantics.
export function stableBaseline(historical, discovery, declaration) {
  for (const [name, value] of Object.entries(historical))
    assert.equal(
      baselineDigest(value),
      declaration.baselines[name],
      `Historical ${name} baseline changed`,
    );
  assert.equal(
    baselineDigest(discovery),
    declaration.discovery,
    "Stable discovery baseline changed",
  );
  assert.equal(declaration.version, 1);
  assert.equal(declaration.stability, "stable");
  assert.match(declaration.introducedIn, /^\d+\.\d+\.\d+(?:-beta\.[1-9])?$/);
  const floor = globalThis.structuredClone(historical.core);
  floor.stability = declaration.stability;
  floor.methods.push(...globalThis.structuredClone(historical.preferences.methods));
  assert.deepEqual(
    floor.methods.map((method) => method.name),
    declaration.methods,
    "Stable method scope changed",
  );
  for (const method of floor.methods) {
    method.stability = declaration.stability;
    method.since = declaration.introducedIn;
    if (method.name === "api.describe") method.resultSchema = globalThis.structuredClone(discovery);
    if (method.name === "preferences.schema")
      method.resultSchema.properties.stability = { const: declaration.stability };
  }
  const protocol = globalThis.structuredClone(historical.protocol);
  protocol.stability = declaration.stability;
  return { floor, protocol };
}
