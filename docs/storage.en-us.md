# Storage locations and reset

[简体中文](storage.zh-cn.md)

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

Location configuration is machine-specific and excluded from settings profiles and
exports. System credentials, external key files, workspace files and remote files
are not moved. See [settings](settings.md#storage-locations) for migration boundaries.
