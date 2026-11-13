# Public installer upgrade acceptance

The **Public Windows installer upgrade** workflow installs two existing public
Windows x64 releases on a disposable GitHub-hosted runner. It downloads each
exact versioned NSIS asset and checks its size and GitHub-published SHA-256 before
execution. This digest checks download integrity; it does not replace the
updater's signature verification.

The workflow starts the old installed executable, writes settings, a profile,
host/group metadata, command history and a minimal frontend fixture's approval
and storage through real application services, then quits normally. It installs
the newer release into the same directory, starts that installed executable with
the same isolated data and WebView directories, and verifies retained values,
plugin fingerprint, permissions, absence of recovery mode and normal shutdown.

Run the workflow manually with `from` and `to` public release tags. The target
must be newer; Beta tags use `.1` through `.9`. Changes to the harness also run a
fixed public release pair on their pull request. No application compilation is
required. The pinned Playwright client connects to the installed WebView2 via
CDP without downloading a browser. Product CSP and binaries remain unchanged.
Elevated hosted runners use temporary, app-specific HKLM WebView2 debugging and
data-folder policies, cleared after each process exits. Existing values are
never overwritten; user-scoped overrides are ignored by recent WebView2 when
elevated, as documented in Microsoft's WebView2 security guidance.

For a target release with local CLI support, enable `check_cli`. This additionally
executes the installed desktop binary's offline version/discovery and all seven
live methods, including a conditional settings update, stale-write rejection
without a state change, and restoration. Leave it
disabled for historical releases that predate the CLI.

Evidence is uploaded for 14 days, including results, installer output, application
logs and screenshots. It contains synthetic QA data only. The harness refuses
ordinary workstations and self-hosted runners because even a custom NSIS install
directory changes per-user application registration. Do not bypass this guard.

A passing run proves the specified installer pair's Windows data-retention
scenario. It does **not** prove in-app OTA handoff, saved credentials, physical
macOS/Linux behavior or every historical upgrade path. Those remain separate
release acceptance checks. This workflow does not publish releases or promote
experimental APIs to stable.

## Public macOS and Linux CLI packages

The **Public packaged local CLI** workflow downloads the exact public macOS
Intel/Apple Silicon archive or Linux x64 Debian package selected by the runner's
actual architecture. It verifies the published size and SHA-256, extracts it and
executes that packaged binary. Linux uses an isolated virtual display and D-Bus
session. Application data stays in the disposable runner's temporary directory;
GitHub tokens are removed from application and CLI subprocesses.

The check runs offline discovery/version before GUI startup, starts the desktop,
then calls all seven local methods. A real conditional preference update is
followed by stale-write rejection and restoration. Results and process logs are
uploaded for 14 days. No compilation or plugin installation is required.

This proves execution of the selected packaged architecture and local protocol.
Extracting a Debian package or application archive does not test installer
registration, Gatekeeper/quarantine, physical hardware or in-app OTA. The harness
terminates only its own disposable application process; that cleanup is not
normal-shutdown acceptance. Windows installer and data retention remain covered
by the separate workflow above.
