# Storage locations and reset

[简体中文](../../zh-cn/guide/storage.md)

Open **Settings → Advanced → Storage locations** to inspect each category's current
path and size. Choose a new folder for one category, or select categories and choose
a parent folder to assign separate subfolders. Environment-managed plugin locations
are locked while that override is active.

**Reset location** returns one category to its default path. **Reset selected
locations** applies this to the selected categories. Resetting a draft that has not
been applied simply removes that draft. Categories already at their default need
no change. Reset controls are disabled while a plan is scheduled.

Review source and destination paths before choosing **Apply on next start**. Current
data is copied by default. Turning copying off starts the category empty; review
shows an explicit warning. Fully quit the application, including its tray process,
then reopen it. Closing and reopening a hidden window does not run migration.

When returning to a default path, Tunnelde first copies and verifies the current
data into staging. Any old data at the default is then archived under
`storage-recovery/<category>/<migration-id>/original`. Database and cache reset only
their named resources; the application root, bootstrap index, unrelated files and
other categories remain in place. Current source data is retained too. The settings
page lists both the retained source and the archived default data for recovery.
Archives are not automatically removed.

All selected copies must be prepared before the location configuration changes.
An interrupted return uses a journal to resume individual entries. If a published
entry was modified, Tunnelde leaves it intact, reports the conflict, and keeps
using the current source. Canceling an interrupted plan restores archived defaults
only when the installed entries can still be verified. Resolve any reported
conflict before retrying or canceling; the application never silently deletes the
changed data. Ordinary moves to custom folders still require empty destinations.

Cancellation is recorded in `storage.json` before any recovery entries are moved.
After an interruption, startup resumes cancellation instead of applying the old
migration. Settings shows **Storage cancellation needs recovery** and **Retry
cancellation** while a conflict remains. A failed cancellation refreshes that state
immediately; choosing a new location stays disabled until recovery completes.

Cancellation retains incoming copies and restoration journals. For an interrupted
return to defaults, incoming data is kept under the migration's recovery directory
as `cancelled`; custom-location copies remain in place. Settings lists these as
**Recovery copy**, including copies from a migration that never completed. Original
defaults are restored with renames that cannot overwrite an existing destination.
Resolve a conflict without removing your only copy of a file. Missing originals
are reported rather than treated as an already completed restore.

An existing staging copy is reused only after its content matches the current
source. An incomplete or changed copy is preserved and blocks publication; cancel
the plan, retain the displayed recovery copy, and schedule the migration again.
Failure cleanup does not recursively remove staging directories. These safeguards
do not establish exclusive ownership against another process changing directory
parents, or guarantee recovery after physical disk failure; keep an external backup.

Location configuration is machine-specific and excluded from settings profiles and
exports. System credentials, external key files, workspace files and remote files
are not moved. See [settings](settings.md#storage-locations) for migration boundaries.

An authorized plugin may ask you to schedule recovery for the next startup. Review
the plugin name, direction and category paths in the confirmation. **Retry** retains
the existing direction; a cancelling plan cannot be switched back to migration.
The request does not restart the app or move data immediately. Settings shows
**Storage recovery scheduled** and labels any previous error as historical until
the next attempt runs. Use **Choose when to restart** to open restart choices.
