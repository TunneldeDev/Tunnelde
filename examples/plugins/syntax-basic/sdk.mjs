import { createInterface } from "node:readline";

/** A dependency-free, bidirectional client for Tunnelde's bounded stdio protocol. */
export function createPlugin(
  { initialize, run, render, shutdown } = {},
  { input = process.stdin, output = process.stdout, timeout = 30000 } = {},
) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
    throw new RangeError("timeout must be an integer between 1 and 120000 ms");
  let sequence = 0;
  let disposed = false;
  const pending = new Map();
  const reader = createInterface({ input, crlfDelay: Infinity });
  function send(message) {
    if (disposed) throw new Error("Plugin transport is closed");
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024)
      throw new Error("Plugin message exceeds 1 MiB");
    output.write(line + "\n");
  }
  function call(method, params = {}, { signal, timeoutMs = timeout } = {}) {
    if (disposed)
      return Promise.reject(new Error("Plugin transport is closed"));
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new Error("Aborted"));
    if (pending.size >= 32)
      return Promise.reject(new Error("Too many outstanding host calls"));
    try {
      if (typeof method !== "string" || !method || method.length > 128)
        throw new TypeError("Invalid host method");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
        throw new RangeError(
          "timeoutMs must be an integer between 1 and 120000 ms",
        );
      if (!params || typeof params !== "object" || Array.isArray(params))
        throw new TypeError("Host params must be an object");
      if (Buffer.byteLength(JSON.stringify(params), "utf8") > 256 * 1024)
        throw new RangeError("Host params exceed 256 KiB");
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (error, value) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(signal.reason ?? new Error("Aborted"));
      const timer = setTimeout(
        () => finish(new Error(`Host call timed out: ${method}`)),
        timeoutMs,
      );
      pending.set(id, { finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        finish(error);
      }
    });
  }
  const host = Object.freeze({
    call,
    describe: () => call("api.describe"),
    log: (message, level = "info") => call("log", { message, level }),
  });
  function close() {
    if (disposed) return;
    disposed = true;
    for (const request of [...pending.values()])
      request.finish(new Error("Plugin transport closed"));
    reader.close();
  }
  async function receive(line) {
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024) return close();
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      !message ||
      message.jsonrpc !== "2.0" ||
      !Number.isSafeInteger(message.id)
    )
      return;
    if (typeof message.method !== "string") {
      const request = pending.get(message.id);
      if (!request) return;
      const error = message.error
        ? Object.assign(
            new Error(message.error.message ?? "Host rejected the request"),
            { code: message.error.code, data: message.error.data },
          )
        : null;
      request.finish(error, message.result ?? null);
      return;
    }
    const params = message.params ?? {};
    let result;
    try {
      switch (message.method) {
        case "initialize":
          result = initialize ? await initialize(params, host) : { ok: true };
          break;
        case "command.run":
          if (!run) throw new Error("No command handler registered");
          result = await run(params.command, params.input ?? {}, host);
          break;
        case "view.render":
          if (!render) throw new Error("No view handler registered");
          result = await render(params.view, params.locale, host);
          break;
        case "shutdown":
          result = shutdown ? await shutdown(host) : null;
          break;
        default:
          throw new Error(`Unknown host method: ${message.method}`);
      }
      send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch (error) {
      if (!disposed) {
        try {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: String(error?.message ?? error).slice(0, 4096),
            },
          });
        } catch {
          close();
        }
      }
    }
  }
  reader.on("line", (line) => {
    void receive(line);
  });
  reader.on("close", close);
  reader.on("error", close);
  input.on("error", close);
  output.on("error", close);
  return Object.freeze({ host, close });
}
