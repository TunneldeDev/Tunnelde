# Monitoring providers

[简体中文](plugin-monitor-ui.zh-cn.md) · [Interface providers](plugin-ui-providers.en-us.md)

The experimental trusted UI SDK exposes `provider: "monitor"` for both the full
monitoring page and compact remote inspector. Declare a component view without
`location`, request `ui.trusted`, `sessions.read` and `monitor.read`, then register
the view normally. Users explicitly select it in Settings → Plugins → Interface
providers. Installation alone never selects a provider.

`props.monitor.snapshot.presentation` distinguishes `page` from `panel`. The
immutable snapshot identifies the connection, host, title and revision; includes
sampling ownership, request state, errors and the latest absolute resource values;
and reports at most 240 timestamped history points. Unknown or invalid metrics are
`null`. `latest.load` is an immutable three-element tuple. Process inspection and
control retain their separate native lifecycle and APIs.

Read history with `monitor.read({ revision, offset? })`. Each page contains at most
128 points, oldest first, with `nextOffset` for continuation. Retained pages are
independent immutable copies. A mismatched revision or invalid offset is rejected.
The current visible frame may call `monitor.refresh()` to request a sample through
the existing shared sampler. Concurrent requests coalesce; completion or failure
appears in a new snapshot. Hidden, closed, disconnected or revoked views cannot
start new work through a retained handle.

`monitor.Charts` optionally mounts the existing native charts/cards, at most once
per provider instance. Omitting it allows custom rendering from the bounded data.
Sampling belongs to the host, so omission does not pause a visible monitor. The
page and panel share one completion-based loop per connection. Closing the last
consumer retires its in-flight result; reopening waits for that transport before
sampling again. Existing history remains available. Application visibility and
lightweight-mode intervals still apply.

The host keeps titles, connection errors, process controls and recovery access.
Provider failure or duplicate chart mounts recover the native interface. Restoring
the built-in interface preserves the existing chart DOM and history. Permissions,
runtime generation and provider selection are checked on each read or refresh.
Trusted frontend code still shares the host execution context; restricted mode
remains the recovery route for code that blocks the UI.

The source contracts live in `src/lib/extensions/contracts/monitor/`: `sample.ts`
and `reading.ts` describe data, while `provider.ts` describes presentation access.
Private projection and authorization live in `extensions/monitor/`; actual native
components and shared sampling live in `features/monitor/components/` and
`features/monitor/runtime/`. The SDK generator mirrors only public contracts,
checks dependency cycles and rejects private type imports. The compatibility entry
point only re-exports domain types. This provider is experimental and does not
change the stable RPC contract or imply that every domain is ready for 1.0.
