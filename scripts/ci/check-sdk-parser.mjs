import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export function checkParserParity(hostResponse, parsedResponse) {
  assert.deepEqual(
    parsedResponse,
    hostResponse,
    "SDK source parser output differs from the serialized host discovery response",
  );
}

async function main(application, hub, responsePath) {
  assert.ok(application && hub && responsePath, "Expected application, hub, and response paths");
  const { loadRustCatalogue } = await import(
    pathToFileURL(resolve(hub, "scripts/sync-sdk.mjs")).href
  );
  const hostResponse = JSON.parse(await readFile(resolve(responsePath), "utf8"));
  checkParserParity(hostResponse, await loadRustCatalogue(application));
  console.log(`SDK parser matches ${hostResponse.methods.length} serialized host methods.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(...process.argv.slice(2));
}
