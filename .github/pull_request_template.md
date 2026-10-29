<!-- SPDX-License-Identifier: GPL-3.0-only -->

## Summary

<!-- What changes, and why. Keep it short. -->

## Testing

<!-- Commands you ran or scenarios you checked. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] No local paths, keys, logs or temporary files added
- [ ] User-facing strings exist in both `zh-CN` and `en-US`
