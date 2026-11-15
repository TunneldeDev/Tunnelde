// Keep observations in the harness process: the updater can close its WebView
// between polling ticks, taking any undrained in-page event queue with it.
export async function observeUpdateProgress(page, progress) {
  await page.exposeFunction("__qaCaptureUpdateState", (state) => {
    const { phase, progress: downloaded, contentLength, error } = state;
    progress.push({ phase, progress: downloaded, contentLength, error });
  });
  await page.evaluate(async () => {
    await globalThis.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "update://state",
      target: { kind: "Any" },
      handler: globalThis.__TAURI_INTERNALS__.transformCallback((event) => {
        void globalThis.__qaCaptureUpdateState(event.payload);
      }),
    });
  });
}
