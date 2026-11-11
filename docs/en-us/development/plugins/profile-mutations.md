# Public profile writes and activation

These experimental methods require both `settings.read` and `settings.write`, a
live approved runtime, and support discovery through `api.describe`. They do not
extend the AI/MCP tool allowlist. Existing native controls, metadata observation
and content reads keep their contracts. Inputs and results have independent DTOs
under `contracts/profiles/data/mutations` and a mirrored machine schema.

## Save, rename and delete

`profiles.drafts.prepare({revision,totalBytes})` reserves an in-memory upload
against the catalogue's `pc1` content revision. `totalBytes` is 1–16515072 UTF-8
bytes. Append nonempty chunks of at most 32768 bytes with
`profiles.drafts.append({draftId,offset,text})`; `offset` must equal the last
acknowledged byte count. Both methods return
`{version:1,draftId,totalBytes,offset}`. Duplicate/out-of-order chunks are rejected
without changing the body; there is no implicit retry.

`profiles.save({revision,draftId,name,id?})` creates a profile when `id` is omitted,
or replaces that existing ID. Null IDs are invalid. Names are trimmed, unique
case-insensitively, 1–64 Unicode characters and contain no control characters.
The upload must contain all eleven public `PreferenceValues` groups and every
required field. Unknown fields, invalid values, forbidden CSS URLs/imports and
silent normalization are rejected. The normal 32-profile and historical total
collection limits still apply. The partial preference-update RPC keeps its
separate 256 KiB bound; a segmented profile is not reduced to that bound.

Creation uses native defaults for excluded private fields. Replacement preserves
the saved profile's private provider selections. Neither operation applies the
profile or alters current preferences. Invalid legacy snapshots are rejected
without repair; metadata renaming/deletion remain available.

`profiles.rename({id,name,revision})` retains the body and selection.
`profiles.delete({id,revision})` clears selection only when deleting the selected
profile; current applied preferences remain unchanged. All three return
`{version:1,id,revision}` with a new content revision and publish native profile
change events. Metadata-only `profiles.observe` retains its separate token.

Decode, validation, hashing and collection serialization run outside the database
lock. The final transaction compares captured raw body and nonce, including
missing-row identity, under live authorization and a one-shot cancellation fence.
Body, nonce and selection cleanup commit together. A concurrent native save or
old writer's content change causes `profiles.conflict`; refresh and review before
starting another operation. A selected-ID change alone does not invalidate the
content revision and is preserved if the profile still exists.

## Runtime ownership and cancellation

Drafts belong to the plugin ID, installed fingerprint and runtime generation;
knowing a draft ID grants no authority. Four global/two per runtime drafts reserve
at most 32 MiB in aggregate. Idle expiry is 120 seconds and absolute expiry is
600 seconds; expiry is reclaimed on subsequent registry operations or retirement.
No files are staged on disk. Older runtime cleanup cannot remove newer uploads.

`profiles.drafts.discard({draftId})` returns `{version:1}` for discarded, absent,
expired or foreign uploads without disclosing another runtime's state. A claimed
worker returns `profiles.draft.busy`. Claimed drafts are one-shot, including failed
validation, and keep their reservation until the worker actually exits.

Four retained mutation workers bound actual unsettled work. Cancellation before
the final commit boundary prevents publication; cancellation after it may lose
the reply even though the commit succeeds. Revocation shares the publication
policy fence. Never blindly retry an uncertain save, rename, delete or activation:
reconcile the current catalogue/preferences first. This is not exactly-once
delivery across transport loss or application restart.

## Activation

`profiles.activate({id,revision,preferencesRevision})` always asks native user
consent. The host supplies the profile identity and known changed group names;
plugins cannot substitute their own approval text. No settings writer, policy or
database lock is held while waiting for the dialog. Denial returns
`profiles.activation.denied` without changing preferences.

After confirmation, the ordered settings writer and final transaction recheck
both versions. Changes to either saved content or current preferences fail with
`profiles.conflict` or `preferences.staleRevision`. Only public values are applied
onto current native settings, retaining private UI provider selections and update
metadata. Preferences, their new revision and selected ID persist atomically;
committed native effects/events publish even if the caller disappears. Removed
proxy profiles follow the existing credential-cleanup behavior.

The result is `{version:1,id,revision,preferencesRevision}`. `activeId` records the
last explicit selection, not equality with all current settings. No restart is
silently performed. Existing restart prompts continue to apply.

## SDK

```js
const profiles = createProfilesClient(host);
const current = await profiles.catalogue({ signal: owner.signal });
const saved = await profiles.save(
  { name: "Work", revision: current.revision, values: publicValues },
  { signal: owner.signal, timeoutMs: 90000 },
);
const preferences = await host.call("preferences.snapshot", {}, { signal: owner.signal });
await profiles.activate(
  { id: saved.id, revision: saved.revision, preferencesRevision: preferences.revision },
  { signal: owner.signal },
);
```

The facade also provides `rename` and `remove`. Each mutation requires an owner
signal and one operation deadline (default 90 seconds, maximum 120 seconds).
Save snapshots input before awaiting, validates complete public values, uploads
bounded UTF-8 segments and validates acknowledgements/results. Up to four
unsettled mutations per client include cleanup. Failed uploads attempt a separate
one-second discard with its own signal; runtime retirement/expiry is the fallback.
A transport ignoring cancellation can delay settlement and retains its slot.
No mutation is automatically retried. Ship the referenced SDK modules and use a
transport honoring cancellation/deadlines; no user Node runtime is needed.

Errors include `profiles.mutation.invalidRequest`, `profiles.draft.notFound`,
`profiles.draft.incomplete`, `profiles.draft.invalidOffset`, `profiles.draft.limit`,
`profiles.draft.busy`, existing profile name/size/conflict errors,
`preferences.invalidValue:<public-field>` and current authorization/cancellation
errors. Unexpected internal details are replaced by
`profiles.mutation.unavailable`; user values and raw database errors are not
returned as diagnostics.
