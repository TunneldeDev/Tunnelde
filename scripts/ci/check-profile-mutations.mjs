import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";

const schema = JSON.parse(
  await readFile(
    new URL("../../src-tauri/src/settings_profiles/mutations/schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true });
const validators = Object.fromEntries(
  Object.keys(schema.definitions).map((id) => [
    id,
    ajv.compile({ ...schema, $ref: `#/definitions/${id}` }),
  ]),
);
function valid(type, raw) {
  assert(
    validators[type](raw),
    `Invalid native profile ${type}: ${JSON.stringify(validators[type].errors)}`,
  );
}
export function checkProfileMutations(fixture) {
  assert(Buffer.byteLength(JSON.stringify(fixture.values)) > 1024 * 1024);
  let offset = 0,
    total,
    draftId,
    body = "";
  for (const [index, step] of fixture.upload.entries()) {
    const type = index === 0 ? "prepare" : "append";
    assert.equal(step.method, `profiles.drafts.${type}`);
    valid(type, step.request);
    valid("draft", step.result);
    assert(Buffer.byteLength(JSON.stringify(step.request)) <= 256 * 1024);
    if (index === 0) {
      total = step.request.totalBytes;
      draftId = step.result.draftId;
      assert.equal(step.request.revision, fixture.revision);
    } else {
      assert.equal(step.request.draftId, draftId);
      assert.equal(step.request.offset, offset);
      const bytes = Buffer.byteLength(step.request.text);
      assert(bytes > 0 && bytes <= 32768);
      offset += bytes;
      body += step.request.text;
    }
    assert.equal(step.result.offset, offset);
    assert.equal(step.result.totalBytes, total);
    assert.equal(step.result.draftId, draftId);
  }
  assert.equal(offset, total);
  assert.deepEqual(JSON.parse(body), fixture.values);
  for (const name of ["save", "rename", "delete"]) {
    valid(name, fixture[`${name}Request`]);
    valid("changed", fixture[`${name}Result`]);
    assert.notEqual(fixture[`${name}Result`].revision, fixture[`${name}Request`].revision);
    if (fixture[`${name}Request`].id !== undefined) {
      assert.equal(fixture[`${name}Result`].id, fixture[`${name}Request`].id);
    }
  }
  assert.equal(fixture.saveRequest.draftId, draftId);
  assert.equal(fixture.saveRequest.revision, fixture.revision);
  assert.equal(fixture.renameRequest.id, fixture.saveResult.id);
  assert.equal(fixture.deleteRequest.id, fixture.renameResult.id);
  assert.equal(fixture.renameRequest.revision, fixture.saveResult.revision);
  assert.equal(fixture.deleteRequest.revision, fixture.renameResult.revision);
}
export async function checkProfileMutationConsumer(fixture, sdk) {
  checkProfileMutations(fixture);
  const { createProfilesClient } = await import(
    pathToFileURL(join(resolve(sdk), "profiles/client.mjs")).href
  );
  const expected = [
    ...fixture.upload,
    ...["save", "rename", "delete"].map((name) => ({
      method: `profiles.${name}`,
      request: fixture[`${name}Request`],
      result: fixture[`${name}Result`],
    })),
  ];
  const client = createProfilesClient({
    call: async (method, params) => {
      const step = expected.shift();
      assert(step);
      assert.equal(method, step.method);
      assert.deepEqual(params, step.request);
      return step.result;
    },
  });
  const options = () => ({ signal: new globalThis.AbortController().signal });
  assert.deepEqual(
    await client.save(
      { name: fixture.saveRequest.name, revision: fixture.revision, values: fixture.values },
      options(),
    ),
    fixture.saveResult,
  );
  assert.deepEqual(await client.rename(fixture.renameRequest, options()), fixture.renameResult);
  assert.deepEqual(await client.remove(fixture.deleteRequest, options()), fixture.deleteResult);
  assert.equal(expected.length, 0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, sdk] = process.argv.slice(2);
  assert(path && sdk, "Expected actual producer and SDK path");
  await checkProfileMutationConsumer(JSON.parse(await readFile(path, "utf8")), sdk);
  console.log("Actual large native profile writes satisfy machine schemas and current SDK.");
}
