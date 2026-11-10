import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGroups } from "./schema.mjs";
import { declarations } from "./types.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const destination = join(root, "src/lib/preferences/contracts");
const files = declarations(await loadGroups(root));
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
console.log(`Preference contracts: ${files.size} files ${check ? "checked" : "generated"}.`);
