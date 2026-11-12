import { liveFilePreview } from "@/lib/files/preview/registry";
import { useFilePreview } from "@/store/filePreview";
import { integer, invalid, object, path, token } from "./validation";

export function runFilePreviewAction(input: unknown) {
  const kind = object(input, ["id", "revision", "action", "providerId"]);
  const fields =
    kind.action === "selectProvider"
      ? ["id", "revision", "action", "providerId"]
      : ["close", "retry", "dock", "undock"].includes(kind.action as string)
        ? ["id", "revision", "action"]
        : null;
  if (!fields) throw invalid();
  const request = object(input, fields);
  const preview = liveFilePreview(token(request.id), token(request.revision));
  if (request.action === "close") preview.close();
  else if (request.action === "retry") preview.retry();
  else if (request.action === "dock") preview.dock();
  else if (request.action === "undock") preview.undock();
  else preview.selectProvider(token(request.providerId, 129));
  return { schemaVersion: 1 as const, accepted: true as const };
}
export function openFilePreview(input: unknown) {
  const request = object(input, ["source", "path", "line", "column"]);
  const endpoint = object(request.source, ["kind", "sessionId"]);
  const target = path(request.path);
  const source =
    endpoint.kind === "local"
      ? Object.keys(endpoint).length === 1
        ? { kind: "local" as const }
        : null
      : endpoint.kind === "remote" && target.startsWith("/")
        ? { kind: "remote" as const, sessionId: token(endpoint.sessionId) }
        : null;
  if (
    !source ||
    (source.kind === "local" &&
      !target.startsWith("/") &&
      !/^[a-zA-Z]:[\\/]/.test(target) &&
      !/^\\\\[^\\]+\\[^\\]+/.test(target))
  )
    throw invalid();
  const line = integer(request.line, 0),
    column = integer(request.column, 0);
  useFilePreview.getState().show(target, line, column, source);
  return { schemaVersion: 1 as const, accepted: true as const };
}
