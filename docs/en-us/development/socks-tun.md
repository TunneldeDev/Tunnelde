# SOCKS5 domain routes and TUN adapters

[简体中文](../../zh-cn/development/socks-tun.md)

## Protocol boundary

A proxy group owns one authenticated SSH transport and one local SOCKS5
listener. A client connects to that listener and sends a SOCKS5 `CONNECT`
request. Domain-address requests are forwarded unchanged to the SSH server
through `direct-tcpip`, so the remote host resolves the destination. The local
hosts file and DNS configuration are not consulted or modified.

The implementation supports greeting, no authentication, username/password
authentication, IPv4, IPv6 and domain destinations. TCP `CONNECT` is the only
supported command in the first release. `BIND` and `UDP ASSOCIATE` return a
stable SOCKS reply and are not silently treated as TCP.

The default group listener is loopback-only and unauthenticated. A non-loopback
listener must use username/password authentication; the UI and runtime surface
an exposure warning. Handshake, connection setup, idle connections, concurrent
connections and route counts are bounded.

## Route matching

Routes belong to a proxy group. Their matching order is fixed:

1. exact domain and port;
2. exact domain, any port;
3. longest `*.example.com` wildcard and port;
4. longest wildcard, any port;
5. longest CIDR prefix and port;
6. longest CIDR, any port;
7. the group's miss policy.

Wildcards are limited to the `*.example.com` form. `example.com` does not match
its subdomains. Regular expressions are not accepted. A match sends the
configured target to the SSH server; when the target fields are omitted the
original requested destination is retained.

The miss policy is `direct`, `remote` or `reject`; `direct` is the default.
`remote` preserves the original domain for SSH resolution. `reject` returns a
connection-refused SOCKS reply. A group and its routes share one SSH transport;
a `dedicated` route instead owns a separate local TCP listener. Dedicated listen
fields accept bindable IP addresses only. If a user enters a hostname, the
client may resolve it to a local address and show the final connectable address.

## Runtime and observation

Starting a group establishes its SSH transport, the group listener and any
dedicated listeners. Stopping the group, disconnecting its SSH session,
revoking the owning plugin generation or quitting the application closes the
listeners and all active connections. A group revision change is rejected while
the group is running. A manual stop or explicit disconnect pauses automatic
startup; an unexpected transport close may be retried only when the group's
retry option is enabled.

Connection records expose source, matched rule, target, byte counts, start time
and status. The API can list and close active connections. Raw SSH handles,
stored credentials and authentication verifier material are never exposed.

## TUN adapters

TUN is an optional traffic adapter rather than part of the core proxy runtime.
The host owns groups, rules, miss policy, SSH sessions, authorization, status and
connection observation. The adapter owns the platform TUN device, routes, DNS
integration and a user-space TCP/IP stack, and forwards traffic to the group's
local SOCKS5 endpoint.

A TUN session is bound to one host or proxy group. Switching host or group
requires re-enabling the adapter. DNS modes are:

- `system`: DNS is not intercepted; only IP/CIDR rules can match.
- `synthetic`: matching domains receive synthetic addresses and the original
  domain is restored before the connection enters the SOCKS5 listener.
- `custom`: a configured upstream DNS service is used after explicit risk
  confirmation.

The first release forwards TCP. UDP may be direct or rejected; it must not be
presented as remote forwarding. A helper may be bundled with an adapter and
must be installed and authorized explicitly. Discovery of a `trafficAdapters`
manifest contribution does not grant execution permission. Once installed and
authorized, the grant lasts until the helper publisher/signature identity
changes or the user revokes it.

The helper owns an independent watchdog. If the host or adapter exits
unexpectedly, it removes routes, DNS changes and the virtual interface. If
cleanup fails, the UI must report residual state and offer a repair path.

## Permissions and API

The experimental API is discoverable through `api.describe`:

| Namespace | Permission |
| --- | --- |
| `proxy.groups.*` | `proxy.read` / `proxy.write` |
| `proxy.routes.*` | `proxy.read` / `proxy.write` |
| `proxy.runtime.*` | `proxy.read` / `proxy.write` |
| `proxy.connections.*` | `proxy.read` / `proxy.write` |
| `proxy.tun.attach` | `proxy.tun` |

Every write rechecks the original window/document, runtime lease, revision and
cancellation state. `proxy.tun.attach` returns only the current local SOCKS5
endpoint, one-time authentication information, a route snapshot and revision;
it never returns an SSH handle or raw stored credentials.

## Import and export

Host migration uses `tunnelde-hosts` version 2 when proxy groups or routes are
present. Version 1 documents continue to import. A document without proxy data
is exported as version 1. Version 2 includes proxy groups and routes, remaps
host and group identities on import, and excludes plaintext passwords, SSH
handles and runtime sessions. Password verifier material travels only inside the
existing authenticated encrypted envelope. A plain export omits it. A
password-protected export keeps its existing authenticated encrypted envelope.
A password-authenticated group imported without verifier material remains a
stopped configuration until the user supplies a password; automatic startup
does not bypass that requirement.
