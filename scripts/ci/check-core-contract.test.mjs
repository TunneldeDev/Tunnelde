import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv from "ajv";
import { checkCoreContracts } from "./check-core-contract.mjs";

const floor = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/core-v1.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ allErrors: true });
const clone = (value) => JSON.parse(JSON.stringify(value));
const editor = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/editor-v1.json", import.meta.url),
    "utf8",
  ),
);
const tabBar = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/tab-bar-v1.json", import.meta.url),
    "utf8",
  ),
);
const logging = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/logging-v1.json", import.meta.url),
    "utf8",
  ),
);
const ui = JSON.parse(
  await readFile(new URL("../../tests/fixtures/plugin-compat/ui-v1.json", import.meta.url), "utf8"),
);
const events = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/plugin-compat/events-v1.json", import.meta.url),
    "utf8",
  ),
);

test("event contract accepts legacy null defaults and rejects invalid envelopes and names", () => {
  const contract = events.methods["events.publish"];
  const input = ajv.compile(contract.inputSchema);
  const envelope = ajv.compile(contract.eventSchema);
  for (const event of ["chat", "._:-AZaz09", "x".repeat(128)]) {
    assert.ok(input({ event }));
    assert.ok(input({ event, payload: null, pluginId: "ignored", generation: "ignored" }));
    assert.ok(envelope({ pluginId: "actual", generation: 1, event, payload: null, future: true }));
  }
  for (const event of [
    "",
    "x".repeat(129),
    "chat\n",
    "chat\r",
    "chat\u2028",
    "事件",
    "a/b",
    null,
    1,
  ])
    assert.equal(input({ event }), false, JSON.stringify(event));
  for (const broken of [
    { generation: 1, event: "chat", payload: null },
    { pluginId: "actual", generation: -1, event: "chat", payload: null },
    { pluginId: "actual", generation: 1.5, event: "chat", payload: null },
    { pluginId: "actual", generation: 1, event: "chat" },
  ])
    assert.equal(envelope(broken), false);
  const discovery = { methods: [{ name: "events.publish", stability: "stable", contract }] };
  const responses = {
    samples: [
      {
        method: "events.publish",
        params: { event: "chat" },
        result: null,
        emittedEvents: [{ pluginId: "actual", generation: 1, event: "chat", payload: null }],
      },
      {
        method: "events.publish",
        params: {},
        inputValid: false,
        error: { code: -32602, message: "plugin.api.missing:event" },
        emittedEvents: [],
      },
    ],
  };
  const emptyFloor = { version: 1, methods: {} };
  assert.deepEqual(checkCoreContracts(discovery, responses, emptyFloor), {
    methods: 1,
    samples: 2,
  });
  for (const mutate of [
    (copy) => {
      delete copy.samples[0].emittedEvents;
    },
    (copy) => {
      copy.samples[0].emittedEvents = [];
    },
    (copy) => {
      delete copy.samples[0].emittedEvents[0].pluginId;
    },
    (copy) => {
      copy.samples[0].emittedEvents[0].generation = "1";
    },
  ]) {
    const copy = clone(responses);
    mutate(copy);
    assert.throws(() => checkCoreContracts(discovery, copy, emptyFloor));
  }
});

test("UI schemas allow literal multiline text and reject NUL, malformed fields and results", () => {
  for (const method of ["ui.showMessage", "ui.confirm"]) {
    const validate = ajv.compile(ui.methods[method].inputSchema);
    for (const message of ["user 0000", "\\path\\file", "<b>literal</b>\n下一行\r\n", "😀"])
      assert.ok(validate({ message, future: true }), JSON.stringify(validate.errors));
    for (const message of [null, "", "\0", "text\0\n", false, 1])
      assert.equal(validate({ message }), false, JSON.stringify(message));
    assert.equal(validate({}), false);
    const limit = method === "ui.confirm" ? 220 * 1024 : 4000;
    assert.ok(validate({ message: "x".repeat(limit) }));
    assert.equal(validate({ message: "x".repeat(limit + 1) }), false);
    // JSON Schema counts code points; UTF-16 and UTF-8 wire quotas are separate.
    assert.ok(validate({ message: "😀".repeat(limit) }));
  }
  const notification = ajv.compile(ui.methods["ui.showMessage"].inputSchema);
  for (const kind of [null, "info", "success", "error"])
    assert.ok(notification({ message: "ok", kind }));
  for (const kind of ["", "warn", "INFO", false, 1])
    assert.equal(notification({ message: "ok", kind }), false);
  const shown = ajv.compile(ui.methods["ui.showMessage"].resultSchema);
  const confirmed = ajv.compile(ui.methods["ui.confirm"].resultSchema);
  assert.ok(shown(null));
  for (const value of [true, false, {}]) assert.equal(shown(value), false);
  assert.ok(confirmed(true));
  assert.ok(confirmed(false));
  for (const value of [null, 1, "true", {}]) assert.equal(confirmed(value), false);
});

test("logging schema preserves legacy calls, nullable identifiers and open structured values", () => {
  const validate = ajv.compile(logging.methods.log.inputSchema);
  for (const params of [
    { message: "" },
    { message: "hello", level: "WARNING" },
    { message: "hello", domain: null, operation: null, requestId: null, future: true },
    { message: "hello", fields: { password: { "unvalidated/secret": [[[[[1]]]]] } } },
    { message: "hello", domain: "x".repeat(128), fields: { ["x".repeat(64)]: null } },
  ])
    assert.ok(validate(params), JSON.stringify(validate.errors));
  for (const params of [
    {},
    { message: null },
    { message: "x".repeat(16385) },
    { message: "ok", level: "Info" },
    { message: "ok", level: null },
    { message: "ok", fields: [] },
    { message: "ok", fields: null },
    { message: "ok", fields: { "bad/key": 1 } },
    { message: "ok", fields: { ["x".repeat(65)]: 1 } },
    ...["domain", "operation", "requestId"].flatMap((name) =>
      ["", "a\n", "a\r", "a\u2028", "x".repeat(129), "路径", 1].map((value) => ({
        message: "ok",
        [name]: value,
      })),
    ),
  ])
    assert.equal(validate(params), false, JSON.stringify(params));
  // Structurally valid can still fail byte/depth/node quotas on the host.
  assert.ok(validate({ message: "文".repeat(5462) }));
  assert.ok(validate({ message: "ok", fields: { a: [[[[1]]]] } }));
  const result = ajv.compile(logging.methods.log.resultSchema);
  assert.ok(result(null));
  assert.equal(result(true), false);
  assert.equal(result({ accepted: true }), false);
});

test("tab-bar command schemas require complete advisory context and preserve nullable fields", () => {
  const contract = tabBar.methods["tabBar.set"];
  const validate = ajv.compile(contract.commandContextSchema);
  const input = {
    _locale: null,
    _tabBar: { itemId: "run", tabId: "opaque", tabKind: "future", paneId: "p", value: null },
  };
  assert.ok(validate(input));
  assert.ok(validate({ ...input, _locale: "zh-CN", future: true }));
  assert.ok(validate({ ...input, _tabBar: { ...input._tabBar, value: "远端", future: true } }));
  for (const field of ["_locale", "_tabBar"]) {
    const missing = clone(input);
    delete missing[field];
    assert.equal(validate(missing), false, field);
  }
  for (const field of Object.keys(input._tabBar)) {
    const missing = clone(input);
    delete missing._tabBar[field];
    assert.equal(validate(missing), false, field);
  }
  for (const [field, value] of [
    ["itemId", "bad/id"],
    ["paneId", ""],
    ["tabId", "x\n"],
    ["value", 1],
  ]) {
    assert.equal(
      validate({ ...input, _tabBar: { ...input._tabBar, [field]: value } }),
      false,
      field,
    );
  }
});

test("contract gate rejects missing, failed, malformed and undeclared command samples", () => {
  const discovery = {
    methods: Object.entries(tabBar.methods).map(([name, contract]) => ({
      name,
      contract,
      stability: "stable",
      since: "0.32.0-beta.6",
      permissions: [],
    })),
  };
  const params = { id: "run", title: "Run", kind: "button", command: "go" };
  const responses = {
    samples: [
      {
        method: "tabBar.set",
        params,
        result: null,
        commandInput: {
          _locale: null,
          _tabBar: { itemId: "run", tabId: "opaque", tabKind: "future", paneId: "p", value: null },
        },
      },
      { method: "tabBar.set", params, error: { code: -32000, message: "plugin.tabBar.limit" } },
      { method: "tabBar.remove", params: { id: "run" }, result: true },
      {
        method: "tabBar.remove",
        params: { id: "run" },
        error: { code: -32000, message: "plugin.tabBar.expired" },
      },
    ],
  };
  const emptyFloor = { version: 1, methods: {} };
  assert.deepEqual(checkCoreContracts(discovery, responses, emptyFloor), {
    methods: 2,
    samples: 4,
  });
  for (const mutate of [
    (r) => {
      delete r.samples[0].commandInput;
    },
    (r) => {
      delete r.samples[0].commandInput._tabBar.paneId;
    },
    (r) => {
      r.samples[1].commandInput = r.samples[0].commandInput;
    },
    (r) => {
      r.samples[2].commandInput = r.samples[0].commandInput;
    },
  ]) {
    const copy = clone(responses);
    mutate(copy);
    assert.throws(() => checkCoreContracts(discovery, copy, emptyFloor));
  }
  for (const schema of [undefined, null, { type: "not-a-schema-type" }, false]) {
    const copy = clone(discovery);
    if (schema === undefined) delete copy.methods[0].contract.commandContextSchema;
    else copy.methods[0].contract.commandContextSchema = schema;
    assert.throws(() => checkCoreContracts(copy, responses, emptyFloor));
  }
});

test("editor contract preserves document identity and allows forward-compatible fields", () => {
  const active = ajv.compile(editor.methods["editor.active"].resultSchema);
  const write = ajv.compile(editor.methods["editor.replace"].resultSchema);
  const document = {
    tabId: "editor-one",
    documentId: "document-one",
    version: 1,
    path: "/资料/a.json",
    name: "a.json",
    content: "",
    dirty: false,
  };
  assert.ok(active(null));
  assert.ok(active({ ...document, future: true }));
  const result = {
    tabId: document.tabId,
    documentId: document.documentId,
    version: 1,
    dirty: false,
  };
  assert.ok(write({ ...result, future: true }));
  for (const [validate, sample] of [
    [active, document],
    [write, result],
  ]) {
    for (const key of Object.keys(sample)) {
      const missing = { ...sample };
      delete missing[key];
      assert.equal(validate(missing), false, key);
    }
    for (const version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validate({ ...sample, version }), false);
  }
  const request = ajv.compile(editor.methods["editor.replace"].inputSchema);
  const params = { tabId: "e", documentId: "d", version: 0, text: "" };
  assert.ok(request({ ...params, future: true }));
  assert.equal(request({ ...params, tabId: "x\0y" }), false);
  assert.equal(request({ ...params, documentId: "" }), false);
  assert.equal(request({ ...params, text: null }), false);
  // Character-count validity cannot establish the independent UTF-8 byte quota.
  assert.ok(request({ ...params, text: "中".repeat(43691) }));
});

test("storage schemas match ASCII keys, required fields and arbitrary JSON values", () => {
  const get = ajv.compile(floor.methods["storage.get"].inputSchema);
  const set = ajv.compile(floor.methods["storage.set"].inputSchema);
  for (const key of ["draft.v1-2_3", "a".repeat(128), "._-"]) {
    assert.ok(get({ key }));
    assert.ok(set({ key, value: null, future: true }));
  }
  for (const key of [
    "",
    "a\n",
    "a\r",
    "a\u2028",
    "键",
    "a".repeat(129),
    "../x",
    "__proto__",
    "prototype",
    "constructor",
    null,
    42,
  ]) {
    assert.equal(get({ key }), false, JSON.stringify(key));
    assert.equal(set({ key, value: null }), false, JSON.stringify(key));
  }
  assert.equal(set({ key: "draft" }), false);
  for (const value of [null, false, 0, "", [], {}, { nested: ["你好"] }])
    assert.ok(set({ key: "draft", value }));
});

test("session result preserves required fields but permits future additions", () => {
  const validate = ajv.compile(floor.methods["sessions.list"].resultSchema);
  const session = {
    id: "s",
    hostId: "h",
    title: "Example",
    address: "host:22",
    cols: 80,
    rows: 24,
    connectedAt: 123,
  };
  assert.ok(validate([]));
  assert.ok(validate([{ ...session, future: true }]));
  for (const field of Object.keys(session)) {
    const missing = { ...session };
    delete missing[field];
    assert.equal(validate([missing]), false, field);
  }
  assert.equal(validate([{ ...session, cols: -1 }]), false);
  assert.equal(validate([{ ...session, rows: 1.5 }]), false);
  assert.equal(validate([{ ...session, hostId: null }]), false);
});

test("contract gate detects removed methods, narrowed schemas, permissions and invalid host results", () => {
  const discovery = {
    methods: Object.entries(floor.methods).map(([name, contract]) => ({
      name,
      contract,
      stability: "stable",
      since: "0.21.0",
      permissions: name === "sessions.list" ? ["sessions.read"] : [],
    })),
  };
  const results = {
    "api.describe": { version: 1, methods: [] },
    "sessions.list": [],
    "storage.get": null,
    "storage.set": null,
    "storage.delete": null,
  };
  const responses = {
    samples: Object.keys(floor.methods).flatMap((method) => {
      const params =
        method === "storage.set"
          ? { key: "draft", value: null }
          : method.startsWith("storage.")
            ? { key: "draft" }
            : {};
      return [
        { method, params, result: results[method] },
        {
          method,
          params,
          error: { code: -32001, message: "pluginSecurity.blocked", data: { code: "validation" } },
        },
      ];
    }),
  };
  assert.deepEqual(checkCoreContracts(discovery, responses, floor), { methods: 5, samples: 10 });
  for (const mutate of [
    (d) => d.methods.pop(),
    (d) => {
      d.methods[0].stability = "experimental";
    },
    (d) => {
      d.methods[0].contract.inputSchema.additionalProperties = false;
    },
    (d) => {
      d.methods[1].permissions = [];
    },
  ]) {
    const copy = clone(discovery);
    mutate(copy);
    assert.throws(() => checkCoreContracts(copy, responses, floor));
  }
  const wrong = clone(responses);
  wrong.samples.find((sample) => sample.method === "storage.set").result = {};
  assert.throws(() => checkCoreContracts(discovery, wrong, floor));
  const missing = clone(responses);
  delete missing.samples[1].error.message;
  assert.throws(() => checkCoreContracts(discovery, missing, floor));
  const additions = clone(responses);
  additions.samples[0].result.future = true;
  additions.samples[1].error.future = true;
  assert.doesNotThrow(() => checkCoreContracts(discovery, additions, floor));
});
