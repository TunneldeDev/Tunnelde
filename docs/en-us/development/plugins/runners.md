# Durable remote runners

The experimental `runners.*` API operates on an explicitly deployed native helper and a runtime selected by the user. Deployment requires native confirmation and a fresh remote directory. It does not install a service or implicitly select Node.

Records belong to a plugin and a captured destination, rather than a temporary SSH session ID. New deployments save the host ID, connected address and observed server key. A new connection must match all three before it can poll the existing journal or stop the task. Editing a saved host or trusting a different key cannot silently redirect recovery. Disconnecting SSH or closing Tunnelde preserves acknowledged running tasks. Recovery never repeats `start`, a prompt, or a message.

Stopping a task, retiring its plugin runtime, or cancelling an unfinished launch saves a stop intent before attempting remote cleanup. If the original session has disconnected, `runners.stop` can still save that intent and return `stopRequested: true` with `status: "stopping"`. This acknowledges the request, not process exit. Cleanup retries through available connections with bounded concurrency and backoff, including after reconnect and in restricted mode. It has separate capacity limits so it cannot consume all foreground operation slots.

Only an observed terminal helper status clears a pending stop. A launch whose acknowledgement was lost remains uncertain: `notFound` alone cannot prove that a delayed launch will never run. Such records remain pending until a subsequent observation establishes the outcome. Repeated requests can return `plugin.runners.busy`; callers should wait and retry observation rather than launch a replacement automatically. New messages are rejected while stopping.

Metadata updates use bounded reads and writes, atomic replacement, and revisions checked before applying delayed results. No repository lock is held while waiting for SSH. Private revision and launch fields are storage details; `runners.list` retains its existing public shape. Existing records without those fields remain readable.

This lifecycle does not make the runner API stable, replace active resource handles, grant access to other plugins, or validate account-specific AI configuration. Remote deployment, initialization and credentials still require the appropriate authorization.

## Interrupted deployment

Before a remote mutation, the host durably reserves the deployment and records its
phase. It records directory creation intent before sending `MKDIR`, acknowledges
that creation before uploading, and marks the deployment ready only after every
file closes successfully and authorization is checked again. Package bytes come
from one bounded snapshot matching the approved fingerprint; the selected helper
is limited to 64 MiB and the package snapshot to 32 MiB. Uploads create files
exclusively and refuse a package path that collides with the native helper.

The native recovery screen distinguishes an unsubmitted reservation, unconfirmed
directory creation, incomplete upload and ready deployment. An incomplete deployment
is omitted from `runners.list`, cannot satisfy `runners.start`, and cannot be reused
by `runners.deploy`; the latter returns `plugin.runners.deploymentIncomplete`.
Existing ready records and public listing fields remain compatible. Only a reservation
that has not submitted a remote mutation can be removed after native confirmation;
the exact-record check prevents a delayed confirmation from removing a later phase.

Disconnecting or restarting does not promote an incomplete record to ready. A path
existing on reconnect does not prove ownership or settle a lost mutation response.
Use a fresh directory to deploy again and preserve the recovery record for inspection.
No partial directory is recursively deleted. Safe reconciliation of deployment and
configuration artifacts remains a separate recovery operation; the journal alone
does not prove that remote files have been cleaned up.

## Initialized configuration

`runners.startInitialized` is a separate experimental method. Discover it through
`api.describe` before deployment; older hosts must not be asked to interpret an
extra argument to `runners.start`. A package opts in with
`"remoteRunner": {"configuration": "initialize-v1"}` and declares `ssh.exec`.
The host captures that declaration from the same approved byte snapshot uploaded
to the deployment, and records it with the deployment fingerprint. An older
deployment without the opt-in cannot use the new transport.

Call with `{sessionId, directory, configuration, secrets?}`. Configuration must be
an object of at most 200 KiB; secrets are a string map. The combined RPC still has
the host's 256 KiB request limit. Before reserving a task, the host queries the
exact recorded helper and requires runner protocol 1 and feature
`runner.initialize-config.v1`. Failed or unsupported discovery never falls back
to writing a configuration file. Authorization, the original destination and the
exact deployment revision are checked again after discovery.

The helper receives a bounded schema-version-1 stdin packet and explicit
`--bootstrap initialize-v1`; no configuration values or secrets enter argv or
host runner records. It requires EOF within 10 seconds and validates the entire
packet before creating the task directory. The child is started with
`--initialize-config` and receives `configurationTransport: "initialize-v1"`,
`configuration` and `secrets` in its initialize request. Helper storage starts
empty rather than being seeded from configuration. A plugin may still explicitly
persist data, and this transport cannot guarantee what arbitrary plugin code,
the selected runtime or operating-system crash handling writes to disk.

Launch confirmation, pending stops and reconnect recovery use the existing
revisioned state machine. An interrupted start remains uncertain and is never
replayed. Legacy `runners.start`, configuration files and historical task recovery
remain supported; selecting the new mode does not clean up old artifacts.

## Interrupted file configuration writes

New tasks persist configuration phases independently of launch state: unsubmitted,
creation unconfirmed, write incomplete, and saved. Creation is exclusive with mode
0600 at OPEN; an existing file is never truncated or changed with a later path-based
chmod. The bounded writer checks authorization and the exact task revision between
chunks, after close and before dispatching the helper. A newer stop prevents a late
write completion from launching the task. Recovery never replays configuration writes.

The native recovery screen displays these phases without configuration values or
secrets. A task reporting `notFound` or stopped does not settle an unconfirmed OPEN,
WRITE or CLOSE; such records cannot be forgotten. A saved configuration is not proof
of process startup or artifact cleanup. Explicitly removing an eligible terminal
record retains remote files. Historical records remain readable without inferring
configuration state; `runners.list` and the selected helper protocol are unchanged.

## Recovery and package changes

Open **Settings → Plugins → Remote task recovery** to discover records, including those belonging to stopped or uninstalled plugins. The host can check status and save stop intent without launching the plugin or selecting Node. Records are paged in groups of 32. A saved record or connected SSH transport is not proof that the task is running; remote observations show their check time. Offline, changed, ambiguous and unreviewed destinations remain distinct.

**Open remote files** opens the recorded deployment directory in the regular file
browser and shows the derived configuration path when preparation was recorded.
It reuses a matching user-managed SSH connection. Plugin-owned and dedicated
forwarding connections are excluded. Otherwise, the normal credential and trust
dialog creates an independent background connection to the original saved host.
The captured address and server key are checked before target authentication;
editing the host or trusting a different key cannot redirect this action. The
exact recovery record is checked again before opening the browser. Cancelling or
closing the recovery page disposes unaccepted connections, and abandoned requests
expire after 15 minutes. An accepted connection is managed by the user and survives
plugin stop, removal and restricted mode. The entry grants no automatic deletion
or artifact ownership: ordinary file-browser actions retain their usual behavior.

Older records have no captured destination. They remain readable, but inspection and remote cleanup require explicitly reviewing the original address and key in a native confirmation. When different connections exist for the same saved host, the host refuses to guess which one owns an older record. Review cannot replace an already captured identity. Binding an older record with a pending stop can immediately resume that existing cleanup intent.

Updating a plugin does not automatically transfer an older task to its new package. **Hand over control** requires the currently installed package's existing `ssh.exec` approval and native consent for that specific task. It preserves the original deployment, code and permissions; it does not clear pending stops, launch work, send a prompt, or replay approval. Confirmed terminal tasks and tasks with pending stops cannot be handed over.

The experimental `runners.review` method accepts `{sessionId, runnerId, directory, kind: "destination" | "control"}` and returns `{reviewed: boolean}`. `destination` binds only an unreviewed legacy record; `control` hands one task to the currently authorized package fingerprint. Cancellation returns `false`; changed records, revoked permissions, changed connections or expired confirmation fail without applying the review. Check `api.describe` for availability before calling it. Existing `runners.list` fields stay unchanged and do not expose private identity or ownership metadata.

Removing a task record is available only after confirmed terminal status and no pending stop. It removes local metadata only; remote files remain. An uncertain launch returning `notFound` does not qualify. Native actions use opaque tokens for the complete observed record, and recheck those tokens after confirmation so old pages cannot remove or mutate newer records.

## Helper capability discovery

In an expanded recovery record, **Check helper capabilities** queries only the
recorded helper on the verified original destination. It is available for ready
deployments and task records, independently of starting a plugin runtime. The
query uses `--capabilities` with no task or configuration arguments, a 5-second
time limit and a 4096-byte combined output limit. It never downloads or selects
another helper or runtime.

The result displays the helper version, supported runner protocols and declared
features. Timeout, transport failure, excess output, absent exit status, nonzero
exit, malformed metadata and unsupported schema are distinct results. A rejected
query does not identify an old helper version; existing status and stop actions
remain available. Unknown bounded features are informational. No query result
settles a task, configuration write or deployment, transfers ownership, or permits
artifact deletion. Results are transient and discarded when the record changes.

The versioned envelope and compatibility rules are documented in the helper
repository's `docs/en-us/development/capabilities.md`. This is a native recovery facility;
public RPCs and stable plugin contracts are unchanged.
