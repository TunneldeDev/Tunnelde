# Connection quality

[简体中文](../../zh-cn/guide/connection-quality.md)

## Network and proxy tests

In **Settings → Network & proxies → Test connection**, choose a route and destination,
then select **Test connection**. Results appear directly below the button: median connection
latency, fastest and slowest setup, spread and successful attempts. Expand individual results
to inspect each timing or failure. **Test again** repeats the measurement. Editing the
destination, proxy or default route invalidates previous results.

The test makes up to three TCP connections within a total 15-second budget, using the selected
direct, system-proxy or saved-proxy route. It never falls back to direct after a proxy failure.
Timings include DNS, TCP setup and required proxy negotiation; they are not ping RTT, packet
loss or bandwidth measurements and do not verify TLS or application functionality. Temporary
connections close after measurement. Failures are excluded from timing statistics;
sub-millisecond values display as `<1 ms`, and unavailable timings as `—`.
Median setup at most 100 ms is low latency, at most 300 ms is moderate, and higher is high;
partial failures are reported separately.

## SSH host tests

Open a host's connection dialog. Its initial host-key check shows the time taken to
establish SSH through the configured route. After the entire route is trusted, use
**Connection quality → Test connection** for up to three short SSH connections.

The results show the median setup time, successful attempts, and the difference
between the slowest and fastest successful attempts. Expand **Individual attempts**
for each duration or failure. A failed attempt is never counted as zero milliseconds.

These are connection-establishment measurements, including DNS, proxy negotiation,
SSH key exchange, and authentication to jump hosts where needed. They are not ping
RTTs, network packet-loss estimates or bandwidth measurements. Three successful
attempts do not guarantee a long-lived connection will remain stable. The test does
not log in to the target account, create a terminal, run remote commands or read files.
The target account's credentials are verified when connecting normally.

A median up to 500 ms is described as fast setup; up to 1,500 ms is normal; higher
values are slow. Mixed successes and failures are reported separately. Interpret
these labels with the actual route in mind: a multi-hop route has more setup work.

Testing follows the host's proxy and jump configuration without bypassing them. It
requires trusted keys for the entire route, and stops immediately on an untrusted or
changed key, invalid credentials or invalid configuration. It never accepts keys or
retries failed authentication automatically. A changed key reopens verification.

Use **Cancel** to stop, or close the dialog. Changing the target, route credentials or
trust state also cancels the previous test and discards its results. Tests have a
25-second overall budget, allow only one active test per host and at most four hosts
at once. Temporary SSH connections are closed after probing.

## HTTPS and marketplace downloads

The proxy test defaults to the marketplace route, including its feature override.
You may instead select the update route, inherited default, system, direct, or an
explicit profile. TCP latency and HTTPS availability are separate results. On port
443, a verified HTTPS HEAD request also checks TLS/HTTP through the selected route;
other ports remain TCP-only. A successful CONNECT response alone cannot prove that
GitHub or its redirected release-asset host is reachable. No certificate validation
is disabled and a failed proxy route never silently switches to direct access.
Premature TLS EOF in plugin GET requests is retried at most twice through the same
route; certificate and proxy authentication failures are not retried.
