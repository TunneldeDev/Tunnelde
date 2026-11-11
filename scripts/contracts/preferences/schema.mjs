import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Explicit host mappings define the public groups; never inspect Settings. */
export async function loadGroups(root) {
  const directory = join(root, "src-tauri/src/services/settings/preferences");
  const mapping = await readFile(join(directory, "mapping/mod.rs"), "utf8");
  const names = [...mapping.matchAll(/id:\s*"([a-z]+)"/g)].map(match => match[1]);
  assert.ok(names.length > 0 && new Set(names).size === names.length);
  return Promise.all(names.map(async name => {
    const schema = JSON.parse(await readFile(join(directory, "schema", `${name}.json`), "utf8"));
    assert.equal(schema.title, name);
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, Object.keys(schema.properties));
    const mapping = await readFile(join(directory, "mapping", `${name}.rs`), "utf8");
    const fields = [...mapping.matchAll(/\("([a-zA-Z]+)",\s*"([a-zA-Z.]+)"\)/g)].map(match => [match[1], match[2]]);
    assert.deepEqual(fields.map(([field]) => field).sort(), Object.keys(schema.properties).sort());
    return { name, schema, fields };
  }));
}
