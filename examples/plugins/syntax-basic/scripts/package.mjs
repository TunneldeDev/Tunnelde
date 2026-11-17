#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sdk = await readFile(resolve(root, "sdk.mjs"));
const sha256 = createHash("sha256").update(sdk).digest("hex");
const expected = "c8f22cd663e1978e5ad751e24f27ade321b74746896e915c66a1a1f478f9aaf9";
if (sha256 !== expected) throw new Error(`sdk.mjs checksum mismatch: ${sha256}`);

const output = resolve(process.argv[2] ?? resolve(root, "dist"));
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, "tunnelde-plugin.json"), "utf8"));
const name = `${manifest.id}-${manifest.version}`;
const files = ["tunnelde-plugin.json", "index.mjs", "sdk.mjs", "README.md"];
for (const file of files) {
  const data = await readFile(resolve(root, file));
  await writeFile(resolve(output, basename(file)), data);
}
await writeFile(resolve(output, `${name}.sha256`), `${sha256}  sdk.mjs\n`);
console.log(`Packaged ${name} in ${output}`);
