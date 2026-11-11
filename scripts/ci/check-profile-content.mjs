import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";

const root = new URL("../../", import.meta.url);
const schema = JSON.parse(
  await readFile(new URL("src-tauri/src/settings_profiles/content/schema.json", root), "utf8"),
);
const ajv = new Ajv({ allErrors: true });
const catalogue = ajv.compile({ ...schema, $ref: "#/definitions/catalogue" });
const chunk = ajv.compile({ ...schema, $ref: "#/definitions/chunk" });

/** Validate actual host bytes as well as semantic progress; never rewrite a fixture. */
export function checkProfileContent(fixture) {
  assert.equal(catalogue(fixture.catalogue), true, "Invalid native profile content catalogue");
  assert(
    Array.isArray(fixture.pages) && fixture.pages.length > 1,
    "Expected a real segmented body",
  );
  let offset = 0,
    text = "",
    total;
  for (const [index, page] of fixture.pages.entries()) {
    assert.equal(chunk(page), true, "Invalid native profile content chunk");
    assert.equal(page.id, fixture.catalogue.items[0].id);
    assert.equal(page.revision, fixture.catalogue.revision);
    assert.equal(page.offset, offset);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 131_072);
    assert(Buffer.byteLength(page.text) > 0 && Buffer.byteLength(page.text) <= 65_536);
    if (total === undefined) total = page.totalBytes;
    assert.equal(page.totalBytes, total);
    offset += Buffer.byteLength(page.text);
    text += page.text;
    assert.equal(page.nextOffset, index === fixture.pages.length - 1 ? null : offset);
  }
  assert.equal(offset, total);
  assert(offset > 1024 * 1024, "Fixture must exceed a one-shot public response");
  assert.deepEqual(JSON.parse(text), fixture.values);
}

export async function checkProfileContentConsumer(fixture, sdk) {
  checkProfileContent(fixture);
  const { createProfilesClient } = await import(
    pathToFileURL(join(resolve(sdk), "profiles/client.mjs")).href
  );
  const client = createProfilesClient({
    call: async (method, request) => {
      if (method === "profiles.catalogue") return fixture.catalogue;
      assert.equal(method, "profiles.read");
      assert.equal(request.revision, fixture.catalogue.revision);
      assert.equal(request.id, fixture.catalogue.items[0].id);
      const page = fixture.pages.find((page) => page.offset === request.offset);
      assert(page, "SDK requested a non-native segment");
      return page;
    },
  });
  assert.deepEqual(await client.catalogue(), fixture.catalogue);
  assert.deepEqual(
    await client.read(
      { id: fixture.catalogue.items[0].id, revision: fixture.catalogue.revision },
      { signal: new AbortController().signal },
    ),
    fixture.values,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, sdk] = process.argv.slice(2);
  assert(fixturePath && sdk, "Expected native fixture and SDK directory");
  await checkProfileContentConsumer(JSON.parse(await readFile(fixturePath, "utf8")), sdk);
  console.log(
    "Actual large native profile content satisfies schema and SDK byte-accurate assembly.",
  );
}
