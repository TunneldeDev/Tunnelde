# Network routes, transfers and SSHFS

Connection tests and their limits are described in [English](connection-quality.md)
and [简体中文](../../zh-cn/guide/connection-quality.md).

These features require desktop 0.27.0 or newer. Existing hosts
and preferences keep their current values; no proxy or jump host is required.

## Feature proxies

Open **Settings → Network & proxies**. Add named HTTP CONNECT or SOCKS5 profiles,
then choose a default route. Override application updates, marketplace/downloads,
SSH/SFTP/forwarding, local plugin processes, or an individual plugin independently.
Each choice supports the inherited default, system proxy, direct connection, or a
named profile. Proxy passwords are stored in the operating system credential store.
An empty password keeps the saved value; **Forget saved proxy password** removes it
only when saved. The connection test uses the route selected in its own dropdown.

Proxy profiles are edited inline with separate connection and authentication groups.
Feature routes use aligned controls and stack vertically in narrow panes. Individual
plugin overrides stay in a collapsible list. The connection test labels its destination
address and port separately from the proxy server and locks its inputs until it finishes.

SSH and native HTTP requests use system/environment proxy settings and bypass
rules in system mode. PAC scripts are not evaluated. Explicit SOCKS5 routes resolve
destination hostnames through the proxy. An unavailable or rejected explicit proxy
fails the request instead of silently making a direct connection.

Local executable plugins and AI tasks receive explicit proxy routes through
`HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`, including their lowercase variants.
Loopback traffic bypasses these proxies. System mode inherits the process environment;
it does not translate desktop OS proxy settings into environment variables. An
executable must support the supplied variables. Restart running plugins to apply
route changes. Remote processes use their own host's outbound networking settings.

Preference profiles include proxy metadata and per-feature choices, with no proxy
passwords. Exported metadata includes proxy usernames and addresses. Importing on
another computer requires entering its proxy passwords again. Deleting a proxy or
resetting Network preferences forgets the removed profiles' stored passwords.

## SSH jump hosts

Edit a saved host and expand **Proxy & jump hosts**. Choose a proxy and add saved
hosts in connection order, with the outermost jump first. Reorder or remove entries
with the adjacent controls. The route supports up to eight distinct jump hosts;
the destination cannot also be a jump host. This explicit list is the complete
route: a jump host's own saved jump list is not recursively expanded.

Only the first TCP connection uses the destination route's proxy. Later hops use
authenticated SSH `direct-tcpip` channels. Every hop retains its own password/key
authentication and host-key check. The connection dialog names the machine whose
key is being reviewed, asks for any missing jump credentials, and verifies the
destination before enabling Connect. Changing a route does not bypass key trust.
SFTP, port forwards and SSHFS reuse the resulting authenticated connection.

## Transfer performance

In **Settings → Files → Transfers**, total upload and download limits are set
independently in KiB/s. Both default to `0` (unlimited), apply immediately to
running tasks, and share one budget across concurrent transfers and SFTP data
channels. They remain active when transfer optimization is disabled. Remote to
remote transfers use both budgets; local disk copies use neither. These limits
cover file-transfer payload bytes rather than SSH framing or terminal traffic.

The gauge button on a running transfer opens a task limit. `0` follows
the global limits; a positive value adds a task ceiling and cannot override the
global ceiling. Local disk copies also honor this task limit, without consuming
either global network budget. The task limit is saved with the transfer and survives pause,
reconnection and application restart. Set it to `0` to follow only global limits. Low
speed transfers continue reporting progress, and pause/cancel can interrupt the
limiter wait. Requests already dispatched when a limit changes may finish.
Waiting for bandwidth credit continues driving existing SFTP requests instead of
serializing the transfer. Each segment retains its bounded request pipeline with
both global and task limits; changing a limit does not restart the file or reset
its offsets.

**Settings → Files → Transfers** enables transfer optimization by default. Segment
concurrency, segment size and SFTP requests per segment each default to **Automatic**.
The application selects fewer segments for small files and up to four for larger remote
files; manual concurrency supports 1, 2, 4 or 8 segments. Local copies remain sequential.
Segment size can be automatic or 256 KiB, 1 MiB, 4 MiB or 16 MiB. Request depth can be
automatic or 1, 4, 8, 16 or 32 per segment, with a cap of 64 total in-flight requests.
Changes apply on start/resume and travel with settings profiles.

For optimized remote transfers, automatic segment sizes share the file across the
selected workers, bounded to 1–16 MiB per segment. This keeps the request pipeline
supplied and reduces checkpoint round trips. Automatic windows cover at most
16 MiB for files below 64 MiB and 64 MiB for larger files, across all selected
workers. Explicit segment sizes can produce larger windows.
An interrupted, unconfirmed window is replayed on resume. Smaller manual segments
reduce that replay extent, at the cost of more checkpoint waits. Explicit segment
sizes, local copies and transfers with optimization disabled keep their existing
planning behavior. Segment size does not allocate a buffer of that size.

Local reads and writes use bounded 1 MiB buffers per segment to avoid issuing
disk operations for every network packet. Read-ahead stops at the segment end;
out-of-order download replies retain their explicit file offsets. Each window
flushes its local writes before its resumable prefix is committed. A flush failure
keeps the window uncommitted so recovery rewrites it. These buffers do not change
bandwidth limits or guarantee a particular network speed.

For directory copies without replacement, optimization also overlaps file preparation,
data transfer and publication on the existing channels. Automatic mode processes up to
four directory entries at once; manual concurrency selects 1, 2, 4 or 8. Nested trees
share that limit instead of multiplying it at every level. The task shares a packet
budget across these entries and combines their confirmed progress. A failure or
cancellation stops queued entries and drains active writers before task cleanup.
Overwrite tasks retain sequential atomic publication. The preparation pipeline
works with ordinary SFTP servers; optional small-file archives are described below.

Before copying, Tunnelde scans the source tree to estimate its size. Remote scans reuse
file types and lengths supplied in directory listings, querying missing attributes
separately. At most four metadata operations run across the tree; a smaller configured
request budget is respected. Directory types are checked again before traversal.
Unreadable folders, symbolic links, special files and incomplete required metadata
stop preparation before the destination is created. The size is a progress estimate;
individual files are still checked by the copy and resume protocol.

Copy dispatch obtains each source file's type, size and modification time from
one metadata response. The source is read again after copying and must still
match before publication. Existing remote destination directories are classified
with one LSTAT without following links; a missing directory is created only after
an explicit not-found response. Other metadata errors stop the operation.

Background tasks share a scheduler: up to four tasks run at once across the
application. Each SSH connection has a budget of six transfer channels. An endpoint
reserves one metadata and one data channel; an optimized durable copy reserves
an additional archive channel per endpoint, while a remote overwrite reserves
an additional target channel for atomic publication. This allows two optimized
or overwrite uploads/downloads, three transfers without either extra channel,
or one same-connection copy with up to six channels. Both endpoints are reserved together.
Other tasks show **Queued** before opening channels. Independent connections can
continue while one connection is busy; tasks sharing an endpoint keep their queue
order. Pause/cancel also work while queued. Waiting does not consume file handles,
and cancelling or stopping a plugin releases its queue reservation. Restarted
tasks remain paused until explicitly resumed.

Concurrent segments use explicit file offsets over dedicated SFTP data channels. Uploads,
downloads and remote-to-remote copies honor advertised server packet limits, handle short
reads and do not prefetch past a segment boundary. Metadata and directory operations
retain their own channels. Upload packet sizes use the server's advertised write limit
within a 256 KiB memory bound; servers without a write limit retain the compatible
32 KiB fallback. Each queued packet fits both endpoints, avoiding sequential write
acknowledgements inside a larger logical packet. A journal records the confirmed contiguous prefix before each
window of segments, together with that window's end. Resume verifies only the confirmed
prefix and rewrites the entire interrupted window without truncating the staging file;
sparse writes are never interpreted as completed data. The journal remains until every
byte in the replayed window has been acknowledged and checkpointed. Lowering chunk size
or concurrency cannot leave the old tail behind or exceed the new worker/request budget:
workers stream larger ranges through the same bounded packet pipeline. Legacy markers
without a recorded end conservatively replay the remaining source, because a delayed
write can extend the currently observed file length. Workers stop and drain before file
handles are closed or temporary files can be cleaned.

### Copies within one remote connection

With transfer optimization enabled, background copies between folders on the same
SSH connection use the server's `copy-data` extension when it advertises version
`1`. Source and destination handles share one SFTP data channel, and each request
copies at most 1 MiB directly on the server. File contents do not travel through
the desktop for this data-copy step. Source checks, resume-prefix verification and
metadata operations still use their existing paths. Copies between separate SSH
connections, including connections to the same saved host, use the normal transfer
pipeline; servers without this extension also retain the normal pipeline.

Server copies retain task staging, bounded concurrency, confirmed progress,
pause/cancel and replay of interrupted windows. Progress and speed represent
logical file bytes copied on the server; both configured upload and download
limits still apply. Small-file archive relay and compression are skipped for this
path. An extension error stops the task rather than retrying through a different
transport after an uncertain write.

This optimization does not change move safety. A failed rename across remote
filesystems does not authorize deleting a source file. Moves that cannot establish
safe source removal retain the source and report the limitation.

### Adaptive transfer compression

**Compress transfer data automatically** is enabled by default with transfer
optimization. For ordinary block transfers, tasks totaling less than 256 KiB keep
the standard SFTP path. Larger tasks sample up to 16 KiB each from the beginning, middle and end of the first source file.
Sampling stops at the first region that cannot save at least 10%. Remote samples use
explicit-offset reads without speculative prefetch, up to 48 KiB of payload overall.
Interrupted sampling closes its read-only channel before falling back to SFTP. When all regions are compressible,
they try a temporary Python 3 worker over the existing authenticated SSH connection.
Incompressible tasks retain the SFTP pipeline. Directory tasks reuse that initial
transport choice; each subsequent block still decides whether compression helps.
It uses only the remote standard library, installs no scripts, starts no service,
and exits when its SSH stream closes. Hosts without the required Python/POSIX file
operations, exec access, or matching SFTP/exec home paths fall back to SFTP.

Each bounded block is sampled first. Fast compression is used only when both
the sample and full block save at least 10%; already compressed or random data
usually travels unchanged. Uploads, downloads and remote copies retain their
explicit offsets, shared request limits, bandwidth limits and durable checkpoints.
The worker opens existing regular files only; it never creates or truncates files.
Compressed reads and writes validate their output lengths and reject truncated or
trailing data. Pause, resume and cancellation use the same task-owned staging and
cleanup rules as ordinary SFTP. Disable compression separately under Files if a host
requires the standard SFTP data path. Changes apply on start or resume and travel
with settings profiles.

Progress and speed describe original file bytes, including when fewer compressed
bytes cross the network. Compression benefits depend on file contents and CPU/network
limits.

### Small-file archives

Optimized directory copies can combine files up to 64 KiB into in-memory archives,
with at most eight files and 1 MiB per archive. Uploads, downloads and remote copies
use the same temporary Python worker requirements described above. No archive is
written to disk or installed on the host. Archive members have numeric names and
are matched against a separate validated manifest; arbitrary paths, links and
special files are rejected. Each destination still uses the ordinary task-owned
staging file, source checks, durable checkpoint and individual publication.

Before an archive upload, the application records its staging generation. If the
write is interrupted without acknowledgement, resume retires that temporary file
and creates a fresh generation instead of reusing it. Only the affected small
files restart; completed files retain their verified progress. Delayed requests
cannot recreate retired paths or write into the replacement generation. Pause
also interrupts the archive checkpoint's read-only metadata wait.

Archives are independent of the compression toggle; when compression is enabled,
each archive is compressed only if it saves at least 10%. Single files, larger
files, partially resumed files, overwrites, unsupported hosts and groups that
cannot obtain their entire bandwidth allowance retain the standard range pipeline.
Live speed limits continue to apply. Directory workers share an archive channel;
the scheduler includes it in the per-connection channel budget. A partial group
flushes without waiting for every worker, and failed or cancelled groups drain
before task cleanup. Progress counts original file bytes after acknowledged writes.

## Pause and resume transfers

For local Windows file moves that require copying, the source is held against
ordinary writes and replacement before copying begins. Before removing it, the
application locks the completed destination, compares both files byte for byte,
and flushes the destination to disk. Both handles remain held while durably saving
the file identities, length and SHA-256 in the removal checkpoint and deleting the
source through its handle. An open writer, verification failure, cancellation or
checkpoint failure leaves the source intact. This protection applies to regular
local files; it does not establish the same guarantee for remote or Unix moves.

Other durable copy-based file moves compare the complete committed destination
against the source, then keep the source and show **Needs review**. SFTP and Unix
path-based removal cannot ensure that the checked file has not been replaced or
modified before deletion. Review both locations before explicitly deleting the
source yourself; clearing the task preserves both files. This extra read applies
to moves, not ordinary copies or atomic same-host renames.

Dragging local entries between different Windows drive letters copies them as
background transfers; the originals remain in place. Cut and paste uses a background
move for files. The cut selection clears only after its move succeeds, including
when the file view has been closed or the task was paused and resumed. A failed or
cancelled move keeps the cut selection; later completion cannot clear a newer
selection. Same-source, same-drive moves continue using rename. Folder moves that
require copying remain unavailable; copy the folder instead. Drive-letter routing
does not detect mounted volumes under one drive, UNC shares or remote mount boundaries.

The status-bar **Transfers** entry opens a compact background task list from any
page; F1 → **Background transfers** opens the same list. When the status bar is
hidden, the entry appears in the bottom corner. Pin the list to keep it open while
working elsewhere. Running/paused, attention and finished groups can be collapsed;
finished tasks start collapsed. Large groups load 20 rows at a time. Expand a task
to inspect source/destination paths, remaining bytes and task speed limits.
The file panes keep their full height while transfers run.

File panes refresh when a background transfer settles, including retries started
after its original view has closed. A copy refreshes its destination; a move also
refreshes its source. Nearby completion events are combined into one directory
read per affected pane, without refreshing unrelated hosts.

Drag the transfer window's title to move it, or drag any edge or corner to resize
it. Position and size survive closing, restarting and tray window recreation;
shrinking the application keeps the window inside the visible workbench. Double-click
the title or use Reset layout to restore the default corner placement. Focus the
title and use arrow keys to move, or focus the bottom-right resize handle and use
arrow keys to resize. Hold Shift for one-pixel adjustments. Escape during a drag
cancels that adjustment; Escape otherwise closes the list.

The transfer list offers Pause, Resume, Cancel and Clear. A desktop-owned transfer
stores its task and per-file progress locally. After an interruption or restart,
connect to the same saved host and resume from the list; changing terminal session
IDs does not require recreating the task. Resume can open the connection dialog for
a missing host, including its usual password and host-key checks. The newest live
connection matching the original saved host and recorded address is used; changing
the host's address does not silently redirect an existing transfer. Local transfers
can resume immediately.

If reconnection arrives during an older connection's cleanup attempt, the
application waits for that attempt to release the task, then retries disposal
using the newest matching connection. Unfinished cleanup keeps its pending record.

New remote transfers write their `.tunnelde-….part` file inside a task-owned
`.tunnelde-….stage` sibling directory. Its private mode (0700) is set by the
directory-creation operation itself and verified before opening the file. The
directory is removed after publication or cancellation; cleanup never recursively
deletes unrecognized contents. Local transfers and existing journals retain their
original sibling staging paths. Before continuing, resume compares every retained
byte with the current source, including for cleanly paused and legacy tasks. Matching
sizes and modification times cannot establish content integrity, so they never bypass
this check. The two readers run concurrently with bounded SFTP read-ahead; completed
parallel windows no longer write metadata-only resume checkpoints. Verification may
read a large retained prefix again and has its own visible status. A changed source
or mismatched partial file is rejected without publishing it. This check does not
lock remote files against concurrent changes. Verification
has its own visible status. Cancellation covers its metadata requests, read-only
file opening, reads and closing; a delayed read or CLOSE reply does not block
pausing. The shared connection remains available. Closing an empty remote staging
handle, or data handles whose writes have all been acknowledged, can also stop
waiting when paused. This does not abort a destination data channel shared by
other files in a directory transfer. If a write's result is uncertain, the
application retains the bounded CLOSE wait and the unconfirmed window's journal.
Pause/error handling and recovery do not send truncation requests. Successful transfers
still wait for CLOSE confirmation. Legacy staging-file creation and private-directory creation still await
their server confirmations.

After the private directory has been acknowledged, creating its empty staging file
can stop waiting immediately on pause. The application journals the uncertain open
before sending it. Resume or cancellation removes the known empty child and its
empty parent before proceeding; a delayed original create cannot recreate a file
under the retired parent. Resume uses a newly journalled directory generation.
Nonempty files, links, unexpected permissions or foreign directory contents are
preserved and reported for review. If directory creation committed but its reply
or checkpoint was lost, recovery accepts only an empty private directory at the
recorded path, without changing its permissions. This does not make directory
creation or legacy mutations immediately cancellable.

Pausing during a remote file's final rename stops waiting for the reply. The
application first records that publication is uncertain. On Resume it moves any
surviving, fully written staging file to a newly journalled generation before
using it again; a delayed original rename cannot publish the replacement staging
file. A lost recovery reply retries the same generation. If the original rename
already committed, Resume compares the complete destination against the source
before reporting success. A missing or changed destination fails verification
and remains protected on later retries instead of being uploaded over again.
Successful transfers still wait for publication confirmation before reporting
completion. These checks assume the task-owned staging paths are not independently
modified by another application.

New remote overwrite tasks negotiate `posix-rename@openssh.com` version 1 before
uploading. The previous destination remains readable while the new file is staged;
after the staging writer closes, one server-side atomic rename replaces it. These
tasks create no backup. Unsupported servers reject overwrite before new upload data
is written; the application never deletes the old file as a fallback. If the commit
acknowledgement is lost, Resume verifies the completed destination against the source
before reporting success. This provides atomic publication, not protection against
privileged interference or concurrent changes to the staging path.

Local overwrite and older remote tasks with a saved backup transaction retain
the recoverable, verified backup flow. For a move, source removal happens after
the copy succeeds and is checkpointed separately.
If the app is interrupted during source removal, Resume never starts copying again.
For a Windows local file move with the new removal checkpoint, it reacquires file
guards and verifies both identities and the complete contents against the saved
digest before removing the source. If the source is already absent, it reports
success only when the original destination still has the recorded identity, length
and digest. Replaced files, including identical copies, or modified contents require
manual review and are preserved. An open writer or I/O failure leaves the checkpoint
available for retry. Pausing before deletion also preserves it; cancelling keeps
the source if it has not yet been deleted and the committed destination.

Older tasks without this proof and other platforms retain manual review. A missing
source and an existing destination alone do not prove completion. Review errors
keep both paths visible and hide Resume; check both locations before clearing the
task. These guards do not cover privileged interference, pre-existing writable
memory mappings or replacement of parent directory paths.
Pause retains partial data for Resume. Cancel stops the transfer and removes its owned
temporary data before reporting completion. It keeps already completed destination
files and never deletes source data. Cancelled tasks cannot resume. If cleanup fails
(e.g. the remote disconnected), the task becomes **Cleanup pending**, cannot be
resumed, and automatically retries when the destination reconnects. Its retry
button can open the connection dialog. The trash action
**Remove transfer and clean temporary files** deletes task-owned staging files before
removing the journal. If an interrupted overwrite left an original destination
backup, cleanup preserves it and the journal rather than risking a concurrent file
replacement. The task shows the last known backup and destination paths for recovery;
an unrecognized backup is reported separately. Completed destination files and source
files are preserved. Automatic no-replace backup restoration is not yet available.

Local transfer commits and backup creation use a system rename that refuses to
replace an existing entry. If another program creates the destination before
commit, the task fails and preserves that destination, staging data and any
existing backup.

On Windows, successful transfers hold a local backup against ordinary writes,
renames and deletion while checking its size, modification time and complete
content digest. Cleanup deletes that same file object through its held handle.
An existing writer, changed backup or cancellation preserves the backup and the
journal for retry. This does not isolate privileged or memory-mapped changes.

Windows local downloads record the volume, full 128-bit file identifier and creation
time from the newly created staging file's handle. Resuming pins the identified file
against ordinary rename/delete while permitting transfer writes and checkpoint trimming.
After its writers close, publication renames through that same held handle without
unlocking and reopening the staging path. A concurrently created destination is preserved.
Cleanup opens and locks the file, compares its recorded identity, then deletes through
that same handle. A different file is preserved even if its contents are identical.
Unknown staging files, including legacy Windows tasks without an identity record,
require manual inspection before resuming or clearing. The task exposes the exact
temporary path and an action to open its parent folder. Remove the file yourself only
after checking that it is unneeded, then retry cleanup. Filesystems that cannot supply
a usable identifier fail safely and retain the staging file. This does not protect
against privileged interference, parent-directory redirection or every commit race.

Transfer artifact cleanup uses file-only removal. If a staging or backup path
has become a directory, it is preserved rather than recursively deleted. This
does not make SFTP or Unix staging-file removal conditional on file identity. SFTP and Unix
backup cleanup for existing backup transactions keeps the previous destination even after the new destination was
written, with a **Needs review** explanation and both paths. Inspect both files,
remove the backup yourself if no longer needed, then clear the task. Retrying the
transfer cannot safely remove it. Recovery paths have buttons to open their parent
folders in the application; remote folders require a live connection matching the
recorded host and address, and never fall back to local paths.

An offline removal persists its cleanup intent before accessing the connection;
the journal is retained until owned artifacts are cleaned, including across app
restarts. Each cleanup attempt has a bounded wait and cannot run alongside Resume.
Legacy directory transfers with an unidentified original backup keep that backup and
report that recovery is needed. Completed records can be removed while offline.

The transfer list shows transferred and remaining bytes, recent throughput and an
estimated remaining time. Throughput history resets on resume; existing bytes do not
count as newly transferred traffic.

Executable-plugin transfers remain tied to the authorized runtime and cannot resume
after an application restart or privilege revocation.

## Local and remote port forwarding

Open **Port forwarding** in the activity bar to view saved hosts and their running
port count. Expand a host to manage its ports. Host details also provide access. Choose **Add forward**, then
select **Access a remote service** or **Share a local service**. The editor separates
the listening and service endpoints and names the computer that resolves each address.
Names are optional and default to the service address and port. Choose **Save and
start**, or **Save** to keep an inactive rule. Starting creates a dedicated background
SSH connection when needed, using normal credential and host-key verification. All
ports under that host share this connection; **Start all** starts its inactive ports
and **Disconnect** stops its connection and ports. Existing terminal connections
remain independent, and no SSH session selector is required. The forwarding panel
can be dragged into any workspace group, collapsed and restored with its layout intact.

| Direction                       | Listener      | Destination is reached from |
| ------------------------------- | ------------- | --------------------------- |
| Local listener → remote service | This computer | The SSH host                |
| Remote listener → local service | The SSH host  | This computer               |

For a remote database listening on `127.0.0.1:5432`, a local rule could listen on
`127.0.0.1:15432` and forward to `127.0.0.1:5432`. Applications then connect to
local port 15432. For remote forwarding, the destination address refers to this
computer's network rather than the remote host's network.

The rule list keeps Start/Stop visible and puts Edit, Copy local connection address and
Delete in each rule's actions menu. An active rule must be stopped before editing.
Startup failures stay beside the saved rule so Start can retry without creating duplicates;
save failures keep the editor draft. Other open forwarding views refresh after changes.
Edits, deletion confirmations and starts use the version that was reviewed. If another
view or plugin changes or deletes that rule, the old action is rejected and an unsaved
draft is preserved. Cancel and reopen the rule to review its current values before retrying.
Changing a rule back to its previous values does not restore an old confirmation.
Endpoint groups stack vertically in narrow panes.

Stopping waits for the local listener to close or for the SSH server to acknowledge
releasing a remote listener. Actions remain disabled with a **Stopping…** status
until that finishes, so a saved port can be edited and restarted immediately.
If release cannot be confirmed, the rule shows an error; disconnect the host's
forwarding connection before retrying. Interrupted cleanup also reserves its remote
endpoint until cancellation finishes, preventing an older cleanup from closing a
new listener on the same port.

Rules persist, but listeners start manually after connecting. Loopback is the
default; exposing a listener requires confirmation. Remote listeners depend on
the SSH server's forwarding policy and `GatewayPorts`. Stopping a rule or closing
its session stops its listener and existing forwarded connections. Rules owned by
a plugin also stop when its permissions are revoked or its runtime exits.

## SSHFS plugins

The desktop provides native mount APIs that compatible plugins can use. Install a
mount provider from the marketplace, open its contributed view, select a connected
host, browse a remote directory, and choose a local empty directory or unused Windows
drive such as `Z:\`. Mounts default to read only. Runtime and permission approval
depend on the provider.

The mount panel detects FUSE and an SSHFS build with passive/stdin transport support.
It provides installation guidance when dependencies are missing or incompatible;
it does not install drivers.

The native service pipes an authenticated SFTP subsystem directly to SSHFS.
Passwords and private keys are not passed in process arguments, and no local TCP
bridge is exposed. Mount completion is reported after the mount appears in the
operating system. Mount points are reserved across providers.

Use Unmount before disconnecting. Disconnect, plugin stop/revocation and app exit
close authenticated access and attempt normal cleanup. If a directory is busy,
close files using it and retry; forced unmount requires confirmation. Mounts do
not automatically restart. Driver compatibility and platform-specific mount
behavior must also be tested with the installed SSHFS distribution.

## File previews

Select one file in either pane and press Space, click the Preview toolbar button, or
choose Preview from its context menu. Text previews are read only; Markdown opens rendered
with a source switch. Local text is bounded to 512 KiB and remote text to the existing
2 MiB read limit. Unsupported or binary files report a preview error. Remote previews
use the selected pane's SSH session. Close returns focus to the file list; the footer
can open a local file with the OS or edit the selected text file.

Install a compatible preview provider from the marketplace for images, audio,
video, PDF and other supported formats. Provider runtime and permission requirements
are shown in its details. Multiple matching providers appear in a selector; unsupported
binary formats offer a marketplace search. File icon themes are independent of preview
providers.

Images are limited to 32 MiB and PDFs to 128 MiB. Audio/video playback starts on
user action and depends on available system codecs. PDF rendering loads on demand
and does not execute document scripts. Remote media uses bounded range requests
over the selected SSH session without a temporary copy on the remote machine.
Closing the preview revokes its access ticket and closes its file handles. Built-in
text/Markdown remains available without a plugin; provider-based text/Markdown is
limited to 2 MiB. See [preview contribution APIs](../development/plugins/README.md#file-preview-providers)
for supported extensions and resource limits.

[简体中文](../../zh-cn/guide/network-storage.md)
