/** All positions count UTF-8 bytes. Use the catalogue's exact content revision. */
export interface ProfileReadRequest {
  readonly id: string;
  readonly revision: string;
  readonly offset: number;
  /** 4-65536; escaping may shorten the returned segment. */
  readonly limit: number;
}

/** Concatenating text in nextOffset order yields public PreferenceValues JSON.
 * No private settings, provider selections, runtime metadata or credentials.
 */
export interface ProfileContentChunk {
  readonly version: 1;
  readonly id: string;
  readonly revision: string;
  readonly offset: number;
  readonly totalBytes: number;
  readonly text: string;
  readonly nextOffset: number | null;
}
