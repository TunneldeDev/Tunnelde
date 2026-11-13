# Native file save installation and recovery

[简体中文](../../zh-cn/development/native-file-saves.md)

The native-save implementation is experimental. The editor still uses its
existing save path; the installation and new native-save workflow is not enabled.
Internal protocol support does not make this a stable local or plugin API.

## Ownership and storage

`ssh/files/native_save` separates protocol contracts, transport, the private
recovery journal, credential storage and desktop recovery projections. Its
journal lives in `<database location>/native-file-saves/recovery.sqlite3`,
separately from the resettable application database. Operation control tokens
belong to a dedicated OS credential-store service and are not part of logs,
installation records or frontend messages.

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
