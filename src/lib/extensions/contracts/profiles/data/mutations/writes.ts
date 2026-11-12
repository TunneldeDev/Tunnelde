/** Create omits id; replace requires an existing id. Claimed drafts are one-shot. */
export interface ProfileSave {
  readonly revision: string;
  readonly draftId: string;
  readonly name: string;
  readonly id?: string;
}
export interface ProfileRename {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
}
export interface ProfileDelete {
  readonly id: string;
  readonly revision: string;
}
export interface ProfileChanged {
  readonly version: 1;
  readonly id: string;
  readonly revision: string;
}
/** Native confirmation always required; both versions rechecked at commit. */
export interface ProfileActivate {
  readonly id: string;
  readonly revision: string;
  readonly preferencesRevision: string;
}
export interface ProfileActivated {
  readonly version: 1;
  readonly id: string;
  readonly revision: string;
  readonly preferencesRevision: string;
}
