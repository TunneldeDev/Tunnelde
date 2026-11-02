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

If explicit color sequences work, check the command's own color settings and shell setup.
For terminal tables, use the same monospace font throughout; xterm uses Unicode grapheme
widths and recalculates its grid when the pane is resized.

## A macOS window does not reopen from the Dock

Update to 0.24.1 or later. Dock reopen events now restore the retained main window, including
after closing, hiding or minimizing it. General settings can hide the Dock icon while the
window is closed; use the menu-bar tray icon or launch Tunnelde again in that mode. Quit
terminates the application.

## An AI plugin only offers Local, or reports a missing working directory

Update the desktop to 0.25.0+ and the assistant plugin to 1.3.0+. Connect a host in the Hosts
sidebar first, then choose its name from the chat's Execution location menu. Model selection
does not select a machine. You do not need to copy a session ID or hand-configure home paths.

Use Workspace and execution settings for a custom cwd or executable. Coding CLIs must be
installed and authenticated on the selected machine; their local login does not authenticate
a separate remote installation. A failed startup displays bounded stderr and native task
errors, including a missing executable. Set its explicit path if a headless SSH session has
a different PATH from your terminal. Do not send login tokens or private keys to the model.

Remote Tunnelde AI needs an explicitly authorized remote Node runtime and confirmation before
uploading source files. Ordinary remote Codex/Claude Code/Pi use SSH stdio and do not require
downloading `tunnelde-agent`. See [the assistant guide](ai-assistants.md).

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
- Updating an installed package requires reviewing its identity and permissions; stop active
  work first. Package replacement retains plugin-scoped settings and validates the new files.
- Archives are capped at 2000 entries and 64 MB unpacked, and entries that escape the target folder
  are rejected.

## Updates

- Windows and Linux AppImage update themselves; `.deb` and unsigned macOS builds are manual, and the
  Updates page links to the release instead of downloading.
