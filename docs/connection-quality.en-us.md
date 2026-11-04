# Connection quality

[简体中文](connection-quality.zh-cn.md)

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
