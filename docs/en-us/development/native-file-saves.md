# Native file save installation and recovery

[简体中文](../../zh-cn/development/native-file-saves.md)

Native saves are an opt-in, experimental remote-editor feature. The editor's
"Enable recoverable saves" action reviews the actual authenticated connection
and file's canonical parent folder before a native installation confirmation.
Other folders keep the existing save path. Internal protocol support does not
make this a stable local or plugin API.

## Enabling a folder

The user reviews the destination/account, folder, exact executable/state paths,
official package URL and local recovery storage. No session ID, runtime path,
protocol version or digest needs to be entered. Cancelled or expired approval
does not install anything. Replacing the connection or folder invalidates the
preparation; it does not redirect the original installation to another host.

The host pins the five reviewed 0.28.0 helper packages by exact byte size and
SHA-256. Downloads use the marketplace proxy route. Partial, truncated,
oversized or mismatching downloads are rejected before upload. Uploaded bytes
are checked before execution. It never uses Node or a PATH-selected agent.

Helpers and per-folder state are grouped beneath the selected folder's private
`.tunnelde/native-file-saves/` directory. Each scope gets an independent helper
installation instead of overwriting another scope's executable. This step
initializes authority, without saving the editor content or starting a daemon.
Local-volume filesystem restrictions still apply, including the helper's
rejection of unsupported network mounts.

## Ownership and storage

`ssh/files/native_save` separates protocol contracts, transport, the private
recovery journal, credential storage and desktop recovery projections. Its
journal lives in `<database location>/native-file-saves/recovery.sqlite3`,
separately from the resettable application database. Operation control tokens
belong to a dedicated OS credential-store service and are not part of logs,
installation records or frontend messages.

Explicit initialization also creates `native-file-saves.initialized` next to
the recovery directory. A missing directory after initialization stays an error
across application restarts. The marker and recovery directory migrate together
with database storage; selecting a blank database location cannot hide either.

Installation intent records capture the authenticated destination, account and
scope, an exact helper/state selection, package version/platform/hash and the
original owner generation. They do not capture passwords or file contents.
Record checksums detect corruption; they are not authentication against an
independent process that can rewrite this private database.

## Installation boundaries

An explicitly authorized installation must record its intent before it may
mutate the remote host. Its transitions are:

| State      | Meaning                                                       | Recovery                                                                              |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reserved   | No remote mutation is authorized yet                          | The exact unsent reservation can be discarded                                         |
| Dispatched | The original worker may have changed the remote host          | Retain the original paths and inspect; do not repeat installation or delete artifacts |
| Ready      | The original worker received a matching initialized authority | Retain the original helper selection and authority for subsequent saves               |

Only the original successful checkpoint creates a single-use installation
permit. A restart or a status read cannot reconstruct it. A late reply must
match the original revision, owner and plan. A mismatched account, scope or OS
cannot replace the original authority. No remote cleanup is inferred from a
missing response or a missing path.

Installation/state paths participate in the existing file admission transaction:
legacy operations cannot delete or overwrite their ancestors or descendants,
and native saves cannot write into these paths. The selected document scope
does not become entirely read-only. Host aliases and Windows SFTP/native path
spellings are compared conservatively; canonical SFTP paths are checked too.

## Format and limits

Opening a journal never creates or upgrades it. An explicit setup upgrade
preserves the journal identity, old native operations and legacy claims, and
adds the version-3 installation table. Readers retain version-1 and version-2
support. Older hosts reject version 3 rather than ignore its installation
reservations; downgrading the schema number is not a supported migration.

There are at most 32 installation records, each at most 64 KiB. Capacity does
not evict unknown installations. Database corruption, a partial schema or a
replaced authority stays unavailable; reading it never resets the evidence.
Transactions use the recovery journal's existing synchronous checkpoints.
Process-exit tests cover committed boundaries and rollback of an uncommitted
schema change, not every possible storage-device power-loss behavior.

Unsent or unknown installation records appear in the existing recovery list.
Their projection includes useful paths and the destination, without owner
generation, package hash, journal identity or private control fields. A historical
record does not assert that an installer is currently running.

## Saving and retiring backups

Native editor saves reserve the original target, authority, baseline and content
digest before using the dedicated OS credential store and durable dispatch
checkpoint. Only an actual matching successful publication returns editor-save
success. Later typing stays dirty, and a replaced document ignores old replies.
An uncertain native result never falls back to an SFTP write.

Background recovery queries the original operation through a matching connection;
it does not submit again after disconnect or process restart. Known publication
may retain the displaced original file. "Review backup cleanup" asks for native
confirmation before discarding that original backup. The next save may offer the
same confirmation. Declining preserves the backup and blocks a conflicting save.
Release uses the original revision; a lost reply stays query-only. A publication
conflict is reported distinctly because the new content may already be live.
