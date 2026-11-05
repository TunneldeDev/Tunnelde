# Plugin overview and compatibility

[简体中文](plugins-overview.zh-cn.md) · [Detailed plugin development guide](plugins.md)

Tunnelde supports independently distributed extensions for commands, views, themes, file
icons and previews. Browse the marketplace to discover extensions, or install a local
folder or ZIP from the Plugins sidebar. Each extension describes its capabilities,
required application version and permissions; available extensions can change over time.

Press **F1**, type `>` and search for a command or view from an installed extension.
Opening the command list does not start the extension. Executing code may require approval.
Tunnelde asks before using an existing system Node runtime; declarative extensions and
theme packs do not require Node. Plugins are not VS Code extensions and cannot generally
run VSIX packages without a compatible extension host.

## Trust and data access

Review the permissions requested by each extension. Executable plugins run separately,
but a trusted plugin with broad permissions can perform powerful operations. Restricted
mode disables plugin execution and access to host capabilities. Permission approval,
runtime consent and host-key verification are separate decisions; extension permissions
do not grant direct access to stored SSH passwords or keys.

## Developing against the host

The [marketplace repository](https://github.com/TunneldeDev/tunnelde-hub) contains the
SDK, TypeScript declarations and generated method catalogue. A plugin manifest specifies
`apiVersion` and may declare an `engines.tunnelde` version range. The host validates both
before running a plugin. `api.describe` provides method discovery for the running host;
approval and permissions still apply to each call.

`apiVersion: 1` identifies the current protocol and is not a blanket promise that every
method, payload or UI state field is stable. In particular, settings, workspace layout,
chat, remote runners and advanced panel APIs may evolve. Avoid relying on undocumented
fields, check capabilities and handle errors. No individual methods are designated stable
until their input, output, errors and lifecycle are documented and compatibility-tested.
Older SDK samples and the host may differ; consult the catalogue shipped with the SDK and
the target host's `api.describe` rather than relying on a fixed method count.

CI also runs a frozen v0.28.0 example through the current host's manifest loader and
JSON-RPC lifecycle. This covers one historical plugin's transport and view response;
it does not establish compatibility for all API methods, permissions or stored data.

The application and marketplace can release independently. Set the minimum application
version to the first release that supports every feature your extension uses, and test on
that version. The detailed guide describes the current contribution and permission model.
