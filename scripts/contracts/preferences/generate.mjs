import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGroups } from "./schema.mjs";
import { declarations } from "./types.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const destination = join(root, "src/lib/extensions/contracts/preferences/data");
const groups = await loadGroups(root);
const files = declarations(groups);
const check = process.argv.includes("--check");
const existing = await readdir(destination, { recursive: true }).catch(error => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const extra = existing.filter(path => path.endsWith(".ts") && !files.has(path.replaceAll("\\", "/")));
assert.deepEqual(extra, [], "Unexpected preference contract files");
for (const [name, expected] of files) {
  const path = join(destination, name);
  if (check) assert.equal((await readFile(path, "utf8")).replaceAll("\r\n", "\n"), expected, `Outdated preference contract: ${name}`);
  else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, expected); }
}
// Preserve the first public import paths without keeping a second DTO definition.
for (const name of files.keys()) {
  const prefix = name.startsWith("groups/") ? "../../../" : "../../";
  const expected = `// Compatibility export; the public preference domain owns the contract.\nexport type * from "${prefix}extensions/contracts/preferences/data/${name.replace(/\.ts$/, ".js")}";\n`;
  const path = join(root, "src/lib/preferences/contracts", name);
  if (check) assert.equal((await readFile(path, "utf8")).replaceAll("\r\n", "\n"), expected, `Outdated preference compatibility export: ${name}`);
  else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, expected); }
}
const bindings = Object.fromEntries(groups.flatMap(({ name, fields }) => fields.map(([field, internal]) => [internal, `${name}.${field}`])));
const projection = "// Generated private host-field mapping. Never export internal keys through the SDK.\nexport const preferencePaths = " + JSON.stringify(bindings, null, 2) + " as const;\n";
const mapping = join(root, "src/lib/preferences/mapping.ts");
if (check) assert.equal((await readFile(mapping, "utf8")).replaceAll("\r\n", "\n"), projection, "Outdated private preference mapping");
else await writeFile(mapping, projection);
console.log(`Preference contracts: ${files.size} files ${check ? "checked" : "generated"}.`);
