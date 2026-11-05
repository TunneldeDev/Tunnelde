# Historical plugin fixture

`v0.28.0/hello` is an unchanged copy of `examples/plugins/hello` from the
`v0.28.0` tag (commit `324ba1950a14311260fd6d47d4b3516520990560`). Its files
are pinned by SHA-256 in the host tests. Add a new fixture for a later release
instead of updating this snapshot.

The opt-in host transport test loads the historical manifest and runs the
plugin through initialization, command, view, error and shutdown exchanges.
It does not cover the full application, permission approval, storage, or host
API calls. CI explicitly supplies its Node executable; the test never discovers
or uses a user's Node runtime automatically.
