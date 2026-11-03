# AI assistants: local and remote execution

Requires Tunnelde 0.25.0+ and the independent assistant plugin packages 1.3.0+ from
[Tunnelde Hub](https://github.com/TunneldeDev/tunnelde-hub). Update both desktop and plugin
when moving from the older profile-based location selector.

## Choose an integration

Codex, Claude Code and Pi launch their corresponding installed coding agents. Their
protocols are Codex app-server, Claude stream-json/control messages and Pi RPC. SSH
carries the structured stdin/stdout connection for remote runs; no public agent port or
generic ACP server is required. A generic ACP adapter is not implemented.

Tunnelde AI uses API connections. Configure a provider URL, exact model ID and API key.
It runs locally or in its own process on a selected SSH machine. In remote mode the
provider network requests originate on that machine. Local API providers on loopback
therefore refer to the selected runtime machine's loopback address.

Each plugin is separately installed, approved, started and stopped. Settings, provider
keys and conversations do not migrate between plugins. The existing coding CLI's own
login and model/provider configuration remain on the execution machine.

## Normal setup

1. Install and approve the plugin through Plugins → Marketplace, a local folder or ZIP.
2. Select a plugin Node runtime. The application does not use system Node without consent.
3. For a coding plugin, install and authenticate the corresponding CLI yourself on the
   execution machine. A default connection is provided; override the executable in
   configuration or workspace settings if it is not on that machine's PATH.
4. Connect an SSH host through the normal host connection UI. Trust and credentials stay
   in that UI; never paste them into AI messages.
5. Open **Execution location** in the chat composer. Choose **Local** or a connected host.
   The host list follows live SSH connections and is independent of model/provider profiles.
6. The native SFTP resolver reads home/directory metadata without listing the home folder
   or executing a shell. No internal session ID needs to be copied. Optional working
   directories accept `~` and relative paths. Local folders have a native picker.
7. Send a message. Selecting a target or opening a view does not start an agent.

The chosen target is remembered per conversation. Changing a populated conversation's
machine or workspace creates another conversation and preserves the previous one. After
reconnection, a saved remote target can rebind only to the same saved host identity.
Disconnected targets produce a connection error; they never silently run locally.

The normal remote location selector currently supports POSIX SSH hosts. Windows local
execution is supported; Windows SSH drive/SFTP mappings are explicitly rejected instead
of being interpreted as POSIX paths.

## Remote runtime consent and files

Codex and Claude Code directly start their selected binary through SSH. Pi first asks
before uploading a permission extension into a newly created `.TunneldeAI/Chats/pi-permissions-*`
directory; its extension forwards tool decisions through the Pi protocol.

For Tunnelde AI, choose an existing remote Node 22+ executable in the location dialog and
approve deployment into a new `.TunneldeAI/Chats/tunnelde-ai-*` directory. Node is neither
detected by execution nor installed automatically. An approved deployment is reused by
that conversation while its source fingerprint and host identity match. Only plugin
source files are uploaded. Configuration, conversation state and model keys are supplied
over encrypted SSH stdin; the bridge retains state in memory and the desktop's plugin store.

Private runtimes are installed under `.TunneldeAI/Runtimes/node-*`; the download
archive is removed after verification and extraction. Conversation deployments are
retained for reuse and checked against their recorded file hashes before deletion.
Deleting a remote conversation requires reconnecting its host so cleanup can finish.
Known legacy source directories migrate under `Chats` at the next approved deployment;
untracked directories and existing runtime executable paths are preserved.

These private source directories are retained for reuse; no existing user file or system
service is overwritten. Failed setup only attempts cleanup of entries it created. Normal
runs use the active SSH connection, stop through the chat control and report lost
connections. They do not provide automatic offline execution or detached recovery.

## Scope and approvals

The selected workspace supplies default paths, command cwd and SSH session context to
model tools. `workspace_context`, `list_sessions` and `list_hosts` expose the current
context and scoped discovery. Listing machines returns authorized metadata, not passwords
or key material. Missing path parameters no longer imply that no host is connected.

| Mode             | Behavior                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| Ask for approval | Human review for commands and mutations                                              |
| Approve for me   | Separate API reviewer; negative/failed/invalid review falls back to a human          |
| Full Access      | Explicit opt-in to supported unrestricted execution; retains selected target context |
| ReadOnly         | API read/discovery tools or Codex's restricted read sandbox; no shell/mutation tools |

Claude Code and Pi CLI ReadOnly remain unavailable because their tool settings alone do
not provide the verified OS read sandbox required here. Executable plugins and coding
agents run with their account's permissions. Scope validation is not a substitute for
an OS sandbox around arbitrary commands.

## Advanced persistent supervisors

Old durable deployments remain available under the collapsed advanced configuration.
They require an explicit deployment directory, remote runtime and optional matching
native helper. They are separate from the ordinary location menu. See
[native helper setup](../native-helpers/README.md). Never assume a disconnected supervisor
has stopped; inspect and stop it explicitly after reconnecting.
