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

## Application-initiated Windows updates

The **Public Windows in-app update** workflow installs only the source release,
seeds the same synthetic data, then invokes the application's real update check
and install commands using the ordinary GitHub source and the target's channel.
The selected version must exactly match `to`; use the latest release eligible for
that channel. Package and signed-version verification use the application's
embedded key. The harness does not install or launch the target itself.

Acceptance requires the old process to exit successfully, the updater to restart
the target installed binary, the same data and plugin approvals to survive
without recovery mode, and the target CLI to work. Window close must remove the
restarted process and local endpoint. The restarted process is not a direct
child, so its exit code is not available; the result records the observed quit
conditions explicitly. No user workstation or self-hosted runner is allowed.

Results include update selection, progress, logs, screenshots and startup/data
checks. This covers the selected Windows public release pair, not macOS/Linux
OTA, real credentials or every historical migration.

For OTA, data uses the disposable runner's native application profile, which must
not exist before the test. NSIS restarts through Explorer and does not inherit
the harness's temporary data-directory environment override. Both processes must
report the same actual database location; logs are collected from the reported
location. Installer-only checks continue using a temporary data override.

## Disposable macOS OTA environment probe

The **Public macOS OTA environment probe** workflow is the first stage of public
macOS OTA acceptance. It compiles a native capability reader, checks the hosted
console session, displays, Accessibility trust and screen-capture preflight, and
attempts a desktop screenshot only after those checks pass. It then selects the
public `v1.2.1` and `v1.3.0` archive metadata using the existing packaged-CLI
selector for the actual architecture. It does not download, extract, launch,
modify or update either application. A passing probe is **not OTA acceptance**,
nor proof that a later GUI driver has the same TCC identity.

Run it manually from a reviewed branch in `TunneldeDev/Tunnelde`, entering
`probe-only` as `acknowledgement`. Once GitHub has registered the workflow:

```sh
gh workflow run macos-ota-probe.yml --repo TunneldeDev/Tunnelde \
  --ref <reviewed-branch> -f acknowledgement=probe-only
```

Check registration before dispatching a newly introduced workflow. If GitHub
reports it unavailable, retain the response and wait for the maintainer's normal
integration; do not merge or publish solely to enable this probe. The selected
`--ref` identifies the reviewed code to execute, not the default branch.
Pull requests run environment-rejection and release-selection tests on Linux,
macOS and Windows. The POSIX ownership/mode/symlink test runs only on Linux/macOS;
the real-entry refusal and context tests run on all three. macOS also compiles
the reader and verifies native JSON serialization without invoking GUI APIs.

The manual job uses fixed GitHub-hosted `macos-15`, a read-only contents token,
checkout without persisted credentials and an eight-minute timeout. Before
creating files, the entry point checks the actual OS, architecture, account and
home; hosted/manual/repository/workflow context; fixed release pair; and canonical
workspace/temp directories without symlink ancestors. It refuses root,
self-hosted, other repositories and ordinary workstations. These checks prevent
accidental execution; environment strings do not attest against a deliberately
spoofing administrator. Do not copy the hosted environment onto a user machine.

Each attempt creates a new owner-only directory at
`$RUNNER_TEMP/tunnelde-macos-ota-probe-<run-id>-<attempt>`. Existing directories
are refused. Helper commands have time and output limits. No application or
service is started; nothing is recursively deleted. Runner disposal owns cleanup.
The `evidence` subdirectory is uploaded for 14 days even when capability checks
fail. `results.json` separates probe success from `otaAttempted: false` and
`otaAccepted: false`; `native.json` preserves capability observations. An early
environment rejection creates no evidence directory and leaves its assertion in
the job log. Screenshots require actual review.

The reader calls `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()`;
it never requests permission, edits TCC, invokes `sudo`, changes security policy
or installs a persistent service. Missing GUI/Accessibility/capture capability
fails the job instead of producing a successful skip. Do not grant permissions
or re-sign the public application to work around failure. A different one-use
environment with explicitly authorized native GUI access is then needed.

### Original public app GUI inspection

The separate **Original public macOS GUI and OTA acceptance** workflow implements
the next inspection stage. Dispatch `macos-public-ota.yml` from the reviewed
branch with `acknowledgement=original-public-ota`. Its current mode is `inspect`:
it does not attempt an update. PR checks test archive rejection, compile the
external native driver and verify refusal before GUI/profile access.

Before launching, the driver repeats its own capability checks and requires no
installed production bundle, native app data/preferences/cache, running app or
credential entry for the production service in the disposable account. The
credential query requests no secret data and forbids authentication UI. No
profile or credential store on a developer machine is inspected.

The runner downloads the unchanged public source archive, verifies its published
size/SHA-256, validates every archive member before extraction, and verifies the
original plist, architecture and code signature. It launches the original binary
with no injected code, data override or GitHub token, confirms the actual database
path with `lsof`, writes synthetic preferences through the stable CLI, and tests
the seven stable methods. A separate native process uses bounded AX traversal,
uniquely matched AXPress and generated OS shortcuts to inspect Settings/Updates
and request normal Quit. This is generated input, not physical keyboard testing.

Each run retains screenshots, AX trees, source/binary hashes, command results and
normal-exit versus forced-cleanup evidence under
`$RUNNER_TEMP/tunnelde-macos-public-ota-<run-id>-<attempt>/evidence` for 14 days.
The original endpoint capability and credential values are not uploaded. Failure
only stops the still-owned direct child; profile cleanup belongs to VM disposal.
`otaAttempted` and `otaAccepted` remain false in this inspection stage.

### Remaining public-package OTA stages

These requirements belong to a subsequent harness; the probe does not implement
them. Keep their evidence separate from the first-stage result:

1. Re-run the hosted guard and inspect the actual GUI driver's capabilities.
   Require a clean disposable native profile, no pre-existing Tunnelde process,
   application data, preferences or app credential entries. Public `1.2.1` uses
   the production Keychain service; a custom data directory or changed plist is
   insufficient on a user account. Do not inspect a real user's credential store.
2. Reuse release selection and CLI helpers to fetch the original source and
   target architecture archives. Record asset IDs, published SHA-256/size,
   independently computed download hashes, original bundle identifier, plist
   version, executable hash, architecture and `codesign --verify --deep --strict`
   results. Do not re-sign, inject libraries, replace runtime code or relax
   TLS/updater signatures. Keep the target archive as a reference; the harness
   must never install or start it on behalf of the updater.
3. Place the unchanged source bundle in a writable, attempt-owned installation
   directory. Start it without GitHub tokens. Through existing services/CLI, seed
   synthetic settings, host metadata and supported storage; record the actual
   database/endpoint location. Use the disposable account's native profile so
   automatic relaunch need not inherit a temporary data override. Verify this
   location in both processes rather than assuming it.
4. Use the real GUI's update check and install controls and ordinary public feed.
   Require the selected version to equal `1.3.0`; if another release is selected,
   stop and review the pair instead of pinning a fake feed or downgrading. Save
   screenshots, download/progress/error logs and the application's signature and
   native-bundle validation outcomes. Metadata selection alone is insufficient.
5. Observe the old process exit and updater-owned automatic restart into the same
   install path; never manually launch the target. Verify the new version,
   original identity/signature, executable hash against the reference and retained
   synthetic values without recovery mode. Reuse the seven stable CLI checks,
   including stale-write rejection/restoration. Record exit codes only where
   observable; non-child process disappearance is not an exit code.
6. Quit through the restarted GUI and verify process/endpoint removal. Record
   normal-quit evidence separately from forced cleanup. Bound waits and clean up
   only processes whose PID, start identity and owned bundle path match this run;
   retain failure and unknown-outcome evidence until runner disposal. Upload
   synthetic results/logs/screenshots without endpoint capabilities or secrets.

This staged workflow needs no signing or release key and adds no product API.
CLI checks, synthetic GUI input and hosted execution do not substitute for
physical keyboard/IME, Gatekeeper or all historical migration acceptance.

References: GitHub's [manual workflow trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)
and [runner variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables);
Apple's [Accessibility trust query](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrusted)
and [screen-capture preflight](<https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()>).
