import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createPlugin } from "../../tests/fixtures/plugin-compat/core-sdk-v1/sdk.mjs";

assert.ok(process.argv[2], "Pass the samples emitted by emit_core_contract_responses");
const { samples } = JSON.parse(await readFile(process.argv[2], "utf8"));
const input = new PassThrough();
const output = new PassThrough();
const lines = createInterface({ input: output });
const plugin = createPlugin({}, { input, output });
let roundtrips = 0;
let rejections = 0;
try {
  for (const sample of samples) {
    if (
      !sample.params ||
      Array.isArray(sample.params) ||
      typeof sample.params !== "object" ||
      Buffer.byteLength(JSON.stringify(sample.params)) > 256 * 1024
    ) {
      await assert.rejects(plugin.host.call(sample.method, sample.params), /object|256 KiB/);
      rejections++;
      continue;
    }
    const frame = once(lines, "line");
    const settled = plugin.host.call(sample.method, sample.params).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    const [line] = await frame;
    const request = JSON.parse(line);
    assert.equal(request.method, sample.method);
    assert.deepEqual(request.params, sample.params);
    const failed = Object.hasOwn(sample, "error");
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        ...(failed ? { error: sample.error } : { result: sample.result }),
      }) + "\n",
    );
    const response = await settled;
    if (failed) {
      assert.ok(response.error, `${sample.method}: SDK swallowed a host failure`);
      assert.equal(response.error.code, sample.error.code);
      assert.equal(response.error.message, sample.error.message);
      assert.deepEqual(response.error.data, sample.error.data);
    } else {
      assert.equal(response.error, undefined);
      assert.deepEqual(response.result, sample.result);
    }
    roundtrips++;
  }
} finally {
  plugin.close();
  lines.close();
  input.destroy();
  output.destroy();
}
console.log(
  `Frozen pre-contract SDK: ${roundtrips} host-result roundtrips and ${rejections} request rejections passed.`,
);
