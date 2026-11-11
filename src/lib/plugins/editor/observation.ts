import { useWorkspace } from "@/store/workspace";
import type { EditorBufferObservation } from "@/lib/extensions/contracts/editor/data/observation";
import type { EditorBufferMetadata } from "@/lib/extensions/contracts/editor/data/identity";
import { bytes, identifier, object } from "./validation";
import { readyBuffer } from "./source";

/** Hash a captured public projection; no buffer content or permanent subscription cache. */
export async function observeBuffer(input: unknown): Promise<EditorBufferObservation> {
  const params = object(input, ["tabId", "revision"]);
  const explicit = Object.hasOwn(params, "tabId");
  const tabId = explicit ? identifier(params.tabId, "tabId") : useWorkspace.getState().activeId;
  if (
    Object.hasOwn(params, "revision") &&
    (typeof params.revision !== "string" ||
      !params.revision ||
      bytes(params.revision) > 128 ||
      /\p{Cc}/u.test(params.revision))
  )
    throw new Error("invalid:revision");
  const document = tabId ? readyBuffer(tabId) : null;
  const snapshot: EditorBufferMetadata | null = document
    ? {
        tabId: document.tabId,
        documentId: document.documentId,
        version: document.version,
        path: document.path,
        name: document.name,
        utf16Length: document.content.length,
        dirty: document.dirty,
      }
    : null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([explicit, tabId, snapshot])),
  );
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return revision === params.revision
    ? { schemaVersion: 1, revision, changed: false }
    : { schemaVersion: 1, revision, changed: true, snapshot };
}
