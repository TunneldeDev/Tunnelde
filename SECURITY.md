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

- Saved SSH passwords, passphrases and plugin API keys use the operating system credential
  store. SSH key files remain files: selected keys stay at their selected location, and pasted
  keys are imported under the app data `keys/` directory with private POSIX permissions.
  SQLite stores key paths and connection metadata rather than private-key contents.
- The webview runs with a strict content security policy and a minimal Tauri capability set; the
  shell plugin is not used.
- Every IPC command validates its arguments before touching storage.
- Direct host API calls require declared permissions and user approval. Node plugins run in
  separate processes with the local account's permissions; this is not an OS sandbox. Restricted
  mode stops executable plugins and blocks their host API calls without disabling theme data.
- AI tool scopes restrict approved targets and canonical file paths. Shell commands and trusted
  coding agents require their own OS isolation when account-wide access is unacceptable. Remote
  credentials and runtime use require explicit selection/approval; SSH trust remains in the host UI.
- Logs are written locally, rotated daily, and never transmitted automatically.

## Out of scope

- Unsigned Windows builds trigger SmartScreen; this is expected until code signing is available.
- macOS builds are unsigned and are updated manually.
- Vulnerabilities in third-party services or in the operating system itself.
