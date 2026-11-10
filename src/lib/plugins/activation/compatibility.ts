/** Manifest admission versions shipped with this host; independent of RPC v1.
 * Legacy market entries may omit metadata; native inspection is authoritative. */
export function supportsManifestVersion(version: number | null | undefined): boolean {
  return version == null || version === 1 || version === 2;
}
