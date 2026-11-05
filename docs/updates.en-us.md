# Application updates

[简体中文](updates.zh-cn.md)

Open **Settings → Updates** to check for a newer version, review its changes, and
download or install it. Updates stay in the settings page. All installations default
to the **Stable** channel. **Public beta (Beta)** also accepts newer beta releases.
Development snapshots are not an in-app update channel; saved legacy development
channel preferences migrate to Stable. Switching channels never forces a downgrade.

## Changes between versions

After an update is found, expand **Release notes · current → target**. Tunnelde loads
the notes for published releases whose versions are newer than the installed version
and no newer than the selected target. Versions are sorted newest first using SemVer,
independently of GitHub's display or publication order.

The Stable channel includes stable releases. The Beta channel includes both stable
and public beta releases. Drafts, development snapshots and unrelated release tags
are excluded. Deleted releases and releases without published notes cannot be
reconstructed. The target is expanded initially; expand another version to read it.
Markdown for collapsed versions is not rendered.

History uses the **application updates proxy** from Network settings. It loads only
when expanded, is shared between open settings panels, and is separate from package
discovery, download and signature verification. A history error does not disable
installation. Switching the source, channel, target or completing another check
invalidates the previous history selection.

If GitHub history is unavailable, the target notes and any pages already loaded are
kept. The page explains that the history is incomplete and offers **Retry**. Completeness
is reported only after all public pages have been read and the target is found.
Loading is bounded to 25 seconds, 10 pages, 8 MiB of responses, 200 relevant releases
and 1 MiB of note text. Reaching a limit is explicitly reported as incomplete.

## Sources and installation

The built-in source is GitHub. A custom HTTPS source uses one `{channel}` placeholder
in the URL path and must serve compatible Tauri manifests and signed packages. Apply
the edited URL before checking again. A custom source currently provides the target
manifest's notes only; Tunnelde does not mix unrelated GitHub history into its results.

Package selection and installation keep the same signature checks regardless of the
source. The package selected by Check is retained for Install. Notes cannot change the
download URL or verification key. Installation restarts the application; platforms
without automatic installation provide a manual download action.

See [release operations](releases.md) for publishing and mirror requirements.
