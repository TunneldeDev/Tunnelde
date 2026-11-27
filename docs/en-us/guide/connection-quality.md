# Connection quality

[简体中文](../../zh-cn/guide/connection-quality.md)

## Network and proxy tests

In **Settings → Network & proxies → Test connection**, choose a route and destination,
then select **Test connection**. Results appear below the button: median, fastest and slowest
times, spread and successful attempts. Expand individual results to inspect each timing or failure.
**Test again** repeats the measurement. Editing the destination, proxy or default route invalidates results.

On port 443, the test makes up to three independent HTTPS HEAD requests through the selected route.
All primary timing statistics and quality labels use successful requests. Each duration includes DNS,
connection setup, verified TLS and waiting for response headers. Connections are not reused, redirects
are not followed, and client initialization is excluded from network timings. Any HTTP status proves a
response, without proving login, download or application success. Even when a local or transparent proxy
immediately acknowledges TCP setup, success requires an HTTPS response; a local `<1 ms` acknowledgement
cannot stand in for the destination request time.

Other ports measure up to three TCP/proxy tunnel setups, including DNS, TCP and proxy negotiation.
They send no application data and do not verify TLS. Local or transparent proxies may acknowledge before
the destination is ready, so these values describe tunnel setup only. Neither test measures ping RTT,
packet loss or bandwidth, and neither tests target login.

Route resolution and all samples share a 15-second budget. Tests use the selected direct, system or
saved proxy route, never falling back to direct after proxy failure. Temporary connections close after
measurement. Failures are excluded rather than counted as zero; sub-millisecond values display as
`<1 ms`, zero spread as `0 ms`, and unavailable timings as `—`. A median at most 100 ms is fast, at most
300 ms is moderate, and higher is slow. Partial failures or incomplete HTTPS sampling are reported
separately. Success counts refer to the displayed measurement type; HTTPS failures cannot appear as
successful TCP samples.

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
explicit profile. Port 443 shows three HTTPS request statistics; other ports remain TCP-only. A successful CONNECT response alone cannot prove that
GitHub or its redirected release-asset host is reachable. No certificate validation
is disabled and a failed proxy route never silently switches to direct access.
Premature TLS EOF in plugin GET requests is retried at most twice through the same
route; certificate and proxy authentication failures are not retried.
