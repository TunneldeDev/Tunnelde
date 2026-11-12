import type {
  FilePreviewObservation,
  FilePreviewProviderPage,
} from "@/lib/extensions/contracts/files/preview/data";
import { filePreviewObservation, liveFilePreview } from "@/lib/files/preview/registry";
import { budget, integer, object, path, token } from "./validation";

export function observeFilePreview(input: unknown): FilePreviewObservation {
  const request = object(input, ["revision"]);
  if (Object.hasOwn(request, "revision")) token(request.revision);
  const { revision, preview } = filePreviewObservation();
  if (revision === request.revision) return { schemaVersion: 1, revision, changed: false };
  if (!preview) return { schemaVersion: 1, revision, changed: true, snapshot: null };
  const value = preview.snapshot;
  token(value.id);
  token(value.revision);
  token(value.attemptId);
  path(value.path);
  integer(value.line, 0);
  integer(value.column, 0);
  integer(value.providerCount, 0);
  if (value.providerId !== null) token(value.providerId, 129);
  if (value.source.kind === "remote") token(value.source.sessionId);
  // Enumerate the public DTO; never serialize a host context, callback or renderer resource.
  return budget<FilePreviewObservation>(
    {
      schemaVersion: 1,
      revision,
      changed: true,
      snapshot: {
        id: value.id,
        revision: value.revision,
        attemptId: value.attemptId,
        source: { ...value.source },
        path: value.path,
        line: value.line,
        column: value.column,
        presentation: value.presentation,
        renderer: value.renderer,
        providerId: value.providerId,
        providerCount: value.providerCount,
        state: value.state,
        errorCode: value.errorCode,
      },
    },
    262144,
  );
}
export function readFilePreviewProviders(input: unknown): FilePreviewProviderPage {
  const request = object(input, ["id", "revision", "offset", "limit"]);
  const id = token(request.id),
    revision = token(request.revision);
  const offset = integer(request.offset, 0),
    limit = integer(request.limit, 16, 32);
  return budget(liveFilePreview(id, revision).readProviders({ revision, offset, limit }), 65536);
}
