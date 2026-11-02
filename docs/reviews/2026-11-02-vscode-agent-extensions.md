# VS Code agent extension investigation

Checked on November 2, 2026 using the official Marketplace listing, published extension
manifest, and the official public repository's recursive tree.

## Claude Code

- Official Marketplace identifier: `anthropic.claude-code`.
- The inspected published manifest was version `2.1.314`, publisher `Anthropic`,
  entry point `./extension.js`, requiring VS Code `^1.94.0`.
- The manifest has no `repository` field. The official public
  `anthropics/claude-code` tree has no extension implementation or webview source;
  `.vscode/extensions.json` is an editor recommendation file, not extension source.
- Both the extension manifest and the repository license reserve Anthropic's rights
  and refer to its legal agreements. A downloadable extension bundle is not an
  open-source license grant. We have not found a public, reusable source release of
  its VS Code UI, and have not copied or reverse engineered it.
- Its contributed commands confirm separate sidebar/editor entry points,
  new/reopened conversations, focus-input actions, and explicit diff acceptance.
  These are useful interaction references, not evidence that a VSIX runs in Tunnelde.

Sources:

- [Official Marketplace listing](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- [Published extension manifest inspected](https://anthropic.gallerycdn.vsassets.io/extensions/anthropic/claude-code/2.1.314/1793322358063/Microsoft.VisualStudio.Code.Manifest)
- [Official repository](https://github.com/anthropics/claude-code)
- [Repository license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)
- [Official VS Code guide](https://code.claude.com/docs/en/vs-code)

## Codex and VSIX compatibility

The official Codex Marketplace identifier is `openai.chatgpt`. OpenAI documents
`codex app-server` as the structured interface used by its IDE integrations.
The public `openai/codex` repository provides the app-server implementation under
Apache-2.0; this does not establish that all code and assets in the Marketplace UI
are available under that license.

Sources:

- [Official IDE integration guide](https://developers.openai.com/codex/ide)
- [Official app-server protocol](https://developers.openai.com/codex/app-server)
- [Codex repository](https://github.com/openai/codex)
- [VS Code extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [VS Code extension capabilities](https://code.visualstudio.com/api/extension-capabilities/overview)

Tunnelde cannot install arbitrary VSIX packages. VS Code extensions expect an
extension host and the `vscode` API, including webviews, commands, workspace/file
services, terminal integration, secrets, authentication, and remote execution.
Supporting a manifest or unpacking a VSIX alone would not provide those services.
Building compatibility would be a separate project with licensing, API, process,
and security boundaries to evaluate.

The current implementation keeps three independent Tunnelde plugins, each invoking
its actual installed agent binary: Codex app-server JSON-RPC, Claude Code
stream-json control protocol, and Pi RPC. Their native structured thinking and tool
events feed a shared, collapsible activity view. Runtime permission prompts,
per-conversation machine selection, and normal Tunnelde workspace controls remain
host-owned.
