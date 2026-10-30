# Troubleshooting

## A terminal shows no colours

Tunnelde asks the server for an `xterm-256color` terminal, forwards every byte unchanged and renders
256-colour output. That was verified against a real SSH pty: `ls --color=always /` and explicit
escape sequences arrive colourised.

When a session still looks monochrome, the remote shell is almost always the reason:

- `ls` only colourises when it is an alias such as `alias ls='ls --color=auto'`, usually set in
  `~/.bashrc` or `/etc/profile.d`. A non-interactive shell, or `root` without a profile, has none.
- Some images force `TERM=dumb` in `/etc/profile` or `~/.bashrc`; check with `echo $TERM` on the
  server.
- `git`, `grep` and `less` follow the same rule (`color.ui`, `--color=auto`, `LESS=-R`).
- If the prompt is coloured by the shell, make sure the shell actually sources its rc file
  (`~/.bashrc` for Bash, `~/.zshrc` for Zsh).

Quick check from the app's terminal:

```sh
printf '\033[31mred\033[0m \033[32mgreen\033[0m\n'
```

If that prints in colour but `ls` does not, the shell configuration is the only missing piece.

## Key login does not work after setup

- Tunnelde keeps its own key pair in `<data>/keys/tunnelde_ed25519` and appends the public half to
  `~/.ssh/authorized_keys` on the server. The host is switched to key authentication when the
  write succeeds.
- `authorized_keys` and `~/.ssh` must not be group or world writable; `sshd` silently refuses the key
  otherwise (`chmod 700 ~/.ssh`, `chmod 600 ~/.ssh/authorized_keys`).
- If the server uses a non-standard home directory or a chrooted `internal-sftp`, the key may land
  outside the account's real home. Add it manually with `ssh-copy-id` and pick the key file in the
  host dialog.

## Plugin installation refuses a folder or archive

- The folder must contain `tunnelde-plugin.json` at its root, or an archive must contain exactly one
  top-level folder with that manifest.
- An id that already exists is never overwritten; uninstall the old copy first.
- Archives are capped at 2000 entries and 64 MB unpacked, and entries that escape the target folder
  are skipped.

## Updates

- Windows and Linux AppImage update themselves; `.deb` and unsigned macOS builds are manual, and the
  Updates page links to the release instead of downloading.
