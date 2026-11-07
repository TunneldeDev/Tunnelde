# Optional native helper

[简体中文](native-helper.zh-cn.md)

The optional `tunnelde-agent` executable is maintained in the independent
[TunneldeDev/Tunnelde-agent repository](https://github.com/TunneldeDev/Tunnelde-agent).
Its source history was extracted from this application's former `native-helpers/` directory.
It has its own versions, tests and releases; desktop releases do not rebuild or renumber it.
Ordinary SSH, SFTP, terminal, API chat and direct SSH agent execution do not require it.

For MCP stdio or advanced persistent remote supervisors, download the matching binary and
`SHA256SUMS` from that repository's releases. Verify SHA-256 before selecting the binary.
For remote execution, choose the remote machine's operating system and architecture.
On macOS and Linux, restore executable permission with `chmod +x <binary>`.
The helper contains no Node runtime and never authorizes use of an external runtime for you.

See the helper repository's [setup and compatibility guide](https://github.com/TunneldeDev/Tunnelde-agent/blob/main/README.en-us.md)
for MCP environment variables, supervisor deployment, build instructions and protocol policy.
Existing helper command arguments, runner records and protocol behavior are preserved by the
repository migration. Do not replace the executable used by a running supervisor.

The helper is absent from desktop installers and desktop release assets. Older desktop tags
still contain their historical helper source; those snapshots remain unchanged. Future helper
changes and bug reports belong in the independent repository.
