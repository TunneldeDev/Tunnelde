import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createPlugin } from "../../tests/fixtures/plugin-compat/core-sdk-v1/sdk.mjs";

assert.ok(process.argv[2], "Pass the samples emitted by emit_core_contract_responses");
const { samples } = JSON.parse(await readFile(process.argv[2], "utf8"));
const input = new PassThrough();
const output = new PassThrough();
// Observe the actual LF protocol, including raw U+2028/U+2029 emitted by old SDKs.
// readline would split those legal JSON string characters and corrupt evidence.
const lines = new EventEmitter();
let buffered = "";
output.setEncoding("utf8");
output.on("data", (chunk) => {
  buffered += chunk;
  let end;
  while ((end = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    lines.emit("line", line);
  }
});
const plugin = createPlugin({}, { input, output });
let roundtrips = 0;
let rejections = 0;
let legacyLogCalls = 0;
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
    const pending = sample.legacySdkLog
      ? plugin.host.log(sample.params.message, sample.params.level)
      : plugin.host.call(sample.method, sample.params);
    if (sample.legacySdkLog) {
      assert.equal(sample.method, "log");
      legacyLogCalls++;
    }
    const settled = pending.then(
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
      })
        .replaceAll("\u2028", "\\u2028")
        .replaceAll("\u2029", "\\u2029") + "\n",
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
  lines.removeAllListeners();
  input.destroy();
  output.destroy();
}
console.log(
  `Frozen pre-contract SDK: ${roundtrips} host-result roundtrips (${legacyLogCalls} legacy log helpers) and ${rejections} request rejections passed.`,
);
