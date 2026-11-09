/** Presentation only: preserve approval decisions and treat all tool text as untrusted. */
export function PluginChatApprovalDetail({ detail }: { detail: string }) {
  if (!detail) return null;
  let value: unknown = detail;
  // Some CLI protocols carry a JSON document inside a JSON string. Unwrap at
  // most two levels; malformed/truncated input remains visible verbatim.
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  if (value !== null && typeof value === "object")
    return <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>;
  return <p className="plugin-chat__plain">{typeof value === "string" ? value : detail}</p>;
}
