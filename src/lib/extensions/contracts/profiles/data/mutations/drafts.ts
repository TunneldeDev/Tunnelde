/** Owned in-memory staging. Offsets/sizes count UTF-8 bytes. */
export interface ProfileDraftPrepare {
  readonly revision: string;
  readonly totalBytes: number;
}
export interface ProfileDraftAppend {
  readonly draftId: string;
  readonly offset: number;
  readonly text: string;
}
export interface ProfileDraftDiscard {
  readonly draftId: string;
}
export interface ProfileDraft {
  readonly version: 1;
  readonly draftId: string;
  readonly totalBytes: number;
  readonly offset: number;
}
export interface ProfileDraftDiscarded {
  readonly version: 1;
}
