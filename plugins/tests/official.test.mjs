import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { runCommand as json, renderView as jsonView } from "../json-formatter/index.mjs";
import { runCommand as timestamp } from "../timestamp/index.mjs";
import { runCommand as uuid } from "../uuid/index.mjs";
import {
  OFFICIAL_PLUGIN_IDS,
  buildPluginArchive,
  packageOfficialPlugins,
} from "../../scripts/plugins/package.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("JSON pretty/minify preserve numeric precision, duplicate keys and literal whitespace", () => {
  const source =
    ' { "big": 900719925474099312345, "big":1e+200, "empty":{}, "array": [ true, null, " a  b \\n" ] } ';
  const compact = json("minify", { source }).text;
  assert.equal(
    compact,
    '{"big":900719925474099312345,"big":1e+200,"empty":{},"array":[true,null," a  b \\n"]}',
  );
  const pretty = json("pretty", { source, indent: "tab" }).text;
  assert.ok(pretty.includes('\n\t"big": 900719925474099312345,'));
  assert.equal(json("minify", { source: pretty }).text, compact);
  assert.equal(json("pretty", { source: "[]" }).text, "[]");
  assert.equal(json("pretty", { source: '" x "' }).text, '" x "');
  assert.equal(json("pretty", { source: '{"a":[]}', indent: "4" }).text, '{\n    "a": []\n}');
});

test("JSON errors contain position, line, column, and views localize", () => {
  const source = '{\n "ok":1,\n bad\n}';
  const result = json("pretty", { source });
  assert.equal(result.error, true);
  assert.equal(result.line, 3);
  assert.ok(result.column >= 2);
  assert.equal(source.slice(0, result.position).split("\n").length, result.line);
  assert.match(json("pretty", { source: "", _locale: "zh-CN" }).title, /无效/);
  assert.equal(jsonView("zh-CN").blocks[1].fields[0].label, "JSON 输入");
});

test("deep JSON pretty printing fails promptly while minifying stays available", () => {
  const source = "[".repeat(1000) + "0" + "]".repeat(1000);
  assert.equal(json("pretty", { source }).error, true);
  assert.equal(json("minify", { source }).text, source);
});

test("timestamps handle epoch, negative seconds, explicit milliseconds and offsets", () => {
  assert.match(
    timestamp("decode", { timestamp: "1.001", unit: "seconds" }).text,
    /Unix milliseconds: 1001\n/,
  );
  assert.match(
    timestamp("decode", { timestamp: "8640000000000", unit: "seconds" }).text,
    /\+275760-09-13/,
  );
  assert.match(
    timestamp("decode", { timestamp: "-8640000000000", unit: "seconds" }).text,
    /-271821-04-20/,
  );
  assert.match(
    timestamp("decode", { timestamp: "0", unit: "seconds", zone: "utc" }).text,
    /1970-01-01T00:00:00.000Z/,
  );
  assert.match(
    timestamp("decode", { timestamp: "-0.001", unit: "seconds", zone: "utc" }).text,
    /1969-12-31T23:59:59.999Z/,
  );
  assert.match(
    timestamp("decode", { timestamp: "1000", unit: "milliseconds" }).text,
    /1970-01-01T00:00:01.000Z/,
  );
  assert.match(
    timestamp("encode", { datetime: "1970-01-01T08:00:00+08:00", zone: "local" }).text,
    /Unix milliseconds: 0\n/,
  );
  assert.match(
    timestamp("encode", { datetime: "1970-01-01T00:00:00", zone: "utc" }).text,
    /Unix seconds: 0\n/,
  );
  assert.match(
    timestamp("encode", { datetime: "2000-02-29T12:34:56.123Z" }).text,
    /2000-02-29T12:34:56.123Z/,
  );
  assert.equal(timestamp("now").error, undefined);
});

test("timestamps reject invalid calendar dates, unsafe numbers and malformed input", () => {
  for (const datetime of [
    "2026-02-29T00:00:00",
    "2026-04-31T00:00:00",
    "2026-12-01T24:00:00",
    "2026-12-01T10:60:00",
    "2026-12-01T10:00:60",
    "2026-12-01T10:00:00+14:01",
    "01/02/2026",
    "",
  ]) {
    assert.equal(timestamp("encode", { datetime, zone: "utc" }).error, true, datetime);
  }
  for (const value of ["", "NaN", "Infinity", "0x100", "1e10", "9007199254740992", "1.001"]) {
    assert.equal(
      timestamp("decode", { timestamp: value, unit: "milliseconds" }).error,
      true,
      value,
    );
  }
});

test("local dates use process local zone and reject daylight-saving gaps", () => {
  const script = `import {runCommand} from ${JSON.stringify(pathToFileURL(join(root, "plugins/timestamp/index.mjs")).href)}; process.stdout.write(JSON.stringify([runCommand("encode",{datetime:"2026-03-08T02:30:00",zone:"local"}),runCommand("encode",{datetime:"1970-01-01T00:00:00",zone:"local"})]));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.equal(results[0].error, true);
  assert.match(results[1].text, /Unix seconds: 18000\n/);
});

test("UUIDs are valid independent v4 values, with batch boundaries enforced", () => {
  for (const count of [1, 100]) {
    const values = uuid("generate", { count: String(count) }).text.split("\n");
    assert.equal(values.length, count);
    assert.equal(new Set(values).size, count);
    for (const value of values)
      assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  for (const count of ["0", "101", "-1", "1.5", "NaN", "1e2", ""])
    assert.equal(uuid("generate", { count }).error, true);
});

test("each independent plugin responds using the real JSON-RPC stdin/stdout protocol", () => {
  for (const id of OFFICIAL_PLUGIN_IDS) {
    const command = id === "json-formatter" ? "pretty" : id === "timestamp" ? "decode" : "generate";
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { apiVersion: 1 } },
      { jsonrpc: "2.0", id: 2, method: "view.render", params: { view: "main", locale: "zh-CN" } },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "command.run",
        params: { command, input: { source: "{}", timestamp: "0", count: "2" } },
      },
      { jsonrpc: "2.0", id: 4, method: "unknown" },
      { jsonrpc: "2.0", id: 5, method: "shutdown" },
    ];
    const child = spawnSync(process.execPath, [join(root, "plugins", id, "index.mjs")], {
      input: messages.map(JSON.stringify).join("\n") + "\n",
      encoding: "utf8",
      timeout: 5000,
      cwd: tmpdir(),
    });
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(responses.length, 5);
    assert.equal(responses[0].result.ok, true);
    assert.equal(responses[1].result.blocks.at(-1).type, "form");
    assert.equal(typeof responses[2].result.text, "string");
    assert.equal(responses[3].error.code, -32601);
    assert.equal(responses[4].result, null);
  }
});

test("invalid JSON-RPC messages do not kill plugin processes", () => {
  for (const id of OFFICIAL_PLUGIN_IDS) {
    const input = "null\n{broken\n" + JSON.stringify({ id: 1, method: "initialize" }) + "\n";
    const child = spawnSync(process.execPath, [join(root, "plugins", id, "index.mjs")], {
      input,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(responses[0].error.code, -32600);
    assert.equal(responses[1].error.code, -32700);
    assert.equal(responses[2].result.ok, true);
  }
});

test(
  "Windows path case variants launch the runtime transport",
  { skip: process.platform !== "win32" },
  () => {
    const entry = join(root, "plugins", "uuid", "index.mjs").toLowerCase();
    const input = JSON.stringify({ id: 1, method: "initialize" }) + "\n";
    const child = spawnSync(process.execPath, [entry], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout.trim()).result.ok, true);
  },
);

function unzip(bytes) {
  const files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const content = inflateRawSync(bytes.subarray(start, start + size));
    assert.equal(content.length, bytes.readUInt32LE(offset + 22));
    files.set(name, content);
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 6), offset);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.size);
  return files;
}

test("official packages are deterministic independent ZIPs with verifiable hashes and root manifests", async () => {
  const output = await mkdtemp(join(tmpdir(), "tunnelde-plugins-"));
  try {
    const index = await packageOfficialPlugins(output);
    assert.equal(index.plugins.length, 3);
    for (const entry of index.plugins) {
      const bytes = await readFile(join(output, entry.archive));
      assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(entry.size, bytes.length);
      assert.deepEqual(bytes, await buildPluginArchive(resolve(root, "plugins", entry.id)));
      const files = unzip(bytes);
      const manifest = JSON.parse(files.get("tunnelde-plugin.json").toString("utf8"));
      assert.equal(manifest.id, entry.id);
      assert.deepEqual(manifest.engines, { node: ">=22" });
      assert.deepEqual(manifest.permissions, []);
      assert.ok(files.has(manifest.main));
      assert.ok(files.has(manifest.readme));
      assert.ok(files.get("LICENSE").equals(await readFile(resolve(root, "LICENSE"))));
      assert.equal(files.size, 4);
    }
    assert.match(await readFile(join(output, "SHA256SUMS"), "utf8"), /json-formatter-1\.0\.0\.zip/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
