// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
//
// Minimal Tunnelde plugin: JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
// stderr is free-form and only used for diagnostics.

import readline from "node:readline";

const write = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const log = (level, message) => {
  write({ jsonrpc: "2.0", method: "log", params: { level, message } });
};

const handle = (message) => {
  const { id, method, params } = message;

  if (method === "initialize") {
    log("info", `initialize api=${params?.apiVersion}`);
    write({ jsonrpc: "2.0", id, result: { ok: true } });
    return;
  }

  if (method === "command.run") {
    log("info", `command=${params?.command}`);
    write({ jsonrpc: "2.0", id, result: { message: "Hello from the example plugin" } });
    return;
  }

  if (method === "shutdown") {
    write({ jsonrpc: "2.0", id, result: null });
    process.exit(0);
  }

  if (id !== undefined) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `unknown method: ${method}` },
    });
  }
};

readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) {
      return;
    }
    try {
      handle(JSON.parse(line));
    } catch (error) {
      log("error", String(error));
    }
  });
