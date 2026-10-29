# Security policy

## Supported versions

Only the latest release receives security fixes. Pre-release builds are provided as-is.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
<https://github.com/TunneldeDev/Tunnelde/security/advisories/new>

Please include the affected version, the platform, reproduction steps and the impact you expect.
Do not open a public issue for a vulnerability, and do not attach real credentials.

You can expect an acknowledgement within seven days. Once a fix is ready we publish a release and
credit the reporter unless anonymity is requested.

## Design commitments

- Passwords, private keys and passphrases are stored only in the operating system credential store,
  never in SQLite or log files.
- The webview runs with a strict content security policy and a minimal Tauri capability set; the
  shell plugin is not used.
- Every IPC command validates its arguments before touching storage.
- Plugins run in separate processes and only receive the permissions declared in their manifest.
- Logs are written locally, rotated daily, and never transmitted automatically.

## Out of scope

- Unsigned Windows builds trigger SmartScreen; this is expected until code signing is available.
- macOS builds are unsigned and are updated manually.
- Vulnerabilities in third-party services or in the operating system itself.
