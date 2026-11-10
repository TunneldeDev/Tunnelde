# Durable remote runners

The experimental `runners.*` API operates on an explicitly deployed native helper and a runtime selected by the user. Deployment requires native confirmation and a fresh remote directory. It does not install a service or implicitly select Node.

Records belong to a plugin and a saved host, rather than a temporary SSH session ID. A new connection to the same host can poll the existing journal. Disconnecting SSH or closing Tunnelde preserves acknowledged running tasks. Recovery never repeats `start`, a prompt, or a message.

Stopping a task, retiring its plugin runtime, or cancelling an unfinished launch saves a stop intent before attempting remote cleanup. If the original session has disconnected, `runners.stop` can still save that intent and return `stopRequested: true` with `status: "stopping"`. This acknowledges the request, not process exit. Cleanup retries through available connections with bounded concurrency and backoff, including after reconnect and in restricted mode. It has separate capacity limits so it cannot consume all foreground operation slots.

Only an observed terminal helper status clears a pending stop. A launch whose acknowledgement was lost remains uncertain: `notFound` alone cannot prove that a delayed launch will never run. Such records remain pending until a subsequent observation establishes the outcome. Repeated requests can return `plugin.runners.busy`; callers should wait and retry observation rather than launch a replacement automatically. New messages are rejected while stopping.

Metadata updates use bounded reads and writes, atomic replacement, and revisions checked before applying delayed results. No repository lock is held while waiting for SSH. Private revision and launch fields are storage details; `runners.list` retains its existing public shape. Existing records without those fields remain readable.

This lifecycle does not make the runner API stable, replace active resource handles, grant access to other plugins, or validate account-specific AI configuration. Remote deployment, initialization and credentials still require the appropriate authorization.
