// Deterministic host protocol fixture, not an installable highlighting plugin.
// Reuse the frozen compatibility SDK instead of shipping a second SDK copy.
import { createPlugin } from "../plugin-compat/core-sdk-v1/sdk.mjs";

createPlugin({
  async run(command, input, host) {
    if (command !== "highlight") throw new Error("unsupported command");
    let source = input.source;
    if (input.mode === "window") {
      source = "";
      const end = input.range.offset + input.range.length;
      for (let offset = input.range.offset; offset < end;) {
        const page = await host.call("editor.readRange", {
          tabId: input.document.tabId,
          documentId: input.document.documentId,
          version: input.document.version,
          offset,
          limit: Math.min(16 * 1024, end - offset),
        });
        source += page.text;
        if (page.nextOffset === null || page.nextOffset <= offset) break;
        offset = page.nextOffset;
      }
    }
    // Deliberately recognize only the two tokens used by the host test input.
    const tokens = [];
    for (const match of source.matchAll(/\bconst\b|\b[0-9]+\b/g)) {
      tokens.push({
        start: match.index,
        end: match.index + match[0].length,
        type: match[0] === "const" ? "keyword" : "number",
      });
      // Keep this deliberately tiny fixture below the host's response budget.
      if (tokens.length === 256) break;
    }
    return { tokens };
  },
});
