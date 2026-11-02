# AI remote target and tool context follow-up

Status: deferred at the user's request on November 2, 2026. This records observed failures and required behavior; no fix has been verified yet.

## Observed behavior in 0.22.2

- The location menu lists provider profiles rather than available connected SSH targets. Selecting a remote machine requires opening configuration and separately entering a session and a remote root.
- A remote root entered as `~/` is accepted by configuration, while the scoped host gateway requires an absolute path. The resulting `plugin.tools.absolutePathRequired` error is shown to the model without actionable context.
- The API assistant exposes file and command tools but no workspace/session discovery tool, although the host gateway already supports scoped `sessions.list` and `hosts.snapshot`.
- The model receives no clear default target, current working directory, or authorized roots. Calls without session IDs are interpreted as local operations; POSIX paths therefore fail on Windows. These failures do not prove that no SSH session is available.
- The conversation incorrectly concluded that there were no available sessions based only on path/working-directory errors, even though the application showed connected hosts and Full Access mode.

## Required behavior

- Separate model/provider selection from tool target selection. Offer connected SSH machines directly in the conversation target menu, with readable names and connection state.
- Selecting a target should establish the session and resolve its home/default working directory without requiring users to copy session IDs or manually maintain redundant lists. Additional path restrictions belong in optional advanced controls.
- Distinguish where the agent process runs from which local/remote machine its tools operate on. Keep each independent CLI plugin's executable identity and permission policy intact.
- Resolve `~` and relative paths against an explicitly selected target before scoped validation. Fail closed outside approved scope; Full Access changes approval behavior, not automatic access to unrelated hosts or local Node execution.
- Give the model a bounded, current workspace context and scoped discovery tools, including session identifiers, machine names, authorized roots and the default working directory, excluding credentials.
- Refresh context when targets, sessions or authorization change. Explain missing/disconnected targets accurately and provide a direct UI remedy; do not infer session absence from an unrelated path error.

## Verification required before closing

- Windows local workspace and POSIX SSH home resolution, including `~/` input.
- Direct switching between two connected SSH machines; disconnected/stale session handling.
- Correct session injection and working directory for listing, reading, writing and commands.
- ReadOnly, Ask, Approve for me and Full Access retain their intended restrictions.
- No prompts asking end users for internal session IDs; no unapproved Node probing or execution.
