import assert from "node:assert/strict";
import { test } from "node:test";
import { observeUpdateProgress } from "./progress.mjs";

test("retain rapid terminal download events outside a destroyed WebView", async () => {
  const observations = [];
  const previous = globalThis.__TAURI_INTERNALS__;
  const previousCapture = globalThis.__qaCaptureUpdateState;
  let handler;
  let subscribed = false;
  globalThis.__TAURI_INTERNALS__ = {
    transformCallback(callback) {
      handler = callback;
      return 7;
    },
    async invoke(command, args) {
      assert.equal(command, "plugin:event|listen");
      assert.equal(args.event, "update://state");
      assert.equal(args.handler, 7);
      subscribed = true;
    },
  };
  try {
    await observeUpdateProgress(
      {
        async exposeFunction(name, callback) {
          globalThis[name] = callback;
        },
        async evaluate(callback) {
          await callback();
        },
      },
      observations,
    );
    assert(subscribed, "Listener must be ready before installation begins");
    for (const downloaded of [0, 4096, 8192]) {
      handler({
        payload: {
          phase: "downloading",
          progress: downloaded,
          contentLength: 8192,
          error: null,
          notes: "Do not copy unrelated state into the evidence stream",
        },
      });
    }
    delete globalThis.__qaCaptureUpdateState;
    assert.deepEqual(
      observations.map((entry) => entry.progress),
      [0, 4096, 8192],
    );
    assert.equal(observations[2].contentLength, 8192);
    assert.equal(Object.hasOwn(observations[2], "notes"), false);
  } finally {
    if (previous === undefined) delete globalThis.__TAURI_INTERNALS__;
    else globalThis.__TAURI_INTERNALS__ = previous;
    if (previousCapture === undefined) delete globalThis.__qaCaptureUpdateState;
    else globalThis.__qaCaptureUpdateState = previousCapture;
  }
});
