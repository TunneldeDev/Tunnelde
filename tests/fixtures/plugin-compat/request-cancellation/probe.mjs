// Explicit opt-in test Node only. The SDK comes from a pinned independent repo.
import { pathToFileURL } from "node:url";
const { createPlugin } = await import(pathToFileURL(process.argv[2]).href);
const runtime = createPlugin(), owner = new AbortController(), mode = process.argv[3];
let timer;
if (mode === "abort") timer = setTimeout(() => owner.abort(new Error("fixture-cancelled")), 100);
if (mode === "close") timer = setTimeout(() => runtime.close(), 100);
let outcome;
try {
  await runtime.host.call("ui.confirm", { message: "Pending test" }, { signal: owner.signal, timeoutMs: mode === "timeout" ? 100 : 10000 });
  throw new Error("Cancelled call unexpectedly resolved");
} catch (error) { outcome = error.message; }
clearTimeout(timer);
const next = mode === "close" ? null : await runtime.host.call("api.describe");
runtime.close();
process.stdout.write(JSON.stringify({ qa: true, outcome, next }) + "\n");
process.stdin.unref();
