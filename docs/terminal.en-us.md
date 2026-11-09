# Terminal keyboard and clipboard

The terminal uses xterm for cursor modes, escape sequences, rendering, mouse reporting and bracketed
paste. SSH carries xterm's input stream; ordinary arrows and control keys are not reconstructed as
text or shell commands. Paste goes through xterm so applications receive their negotiated paste mode.

macOS editing defaults translate desktop gestures into terminal input:

| Gesture                | Terminal sequence   | Common shell behavior     |
| ---------------------- | ------------------- | ------------------------- |
| Command + Left / Right | Ctrl+A / Ctrl+E     | Line start / end          |
| Option + Left / Right  | Escape+b / Escape+f | Previous / next word      |
| Command + Backspace    | Ctrl+U              | Delete towards line start |
| Command + Delete       | Ctrl+K              | Delete towards line end   |

The remote shell or application ultimately interprets these sequences. These defaults follow the
terminal editing conventions used by desktop editors. Search for the Terminal category in keyboard
settings to override or disable individual bindings. Other platforms have no extra defaults for
these commands. Input method composition, AltGr, ordinary cursor keys and unhandled modifiers
remain with xterm. Command+C/V remains copy/paste, Command+A selects the terminal buffer;
Control+C can still interrupt a process.

There are two independent clipboard settings under Terminal → Copy and paste:

- **Copy when selecting text** copies xterm-owned selections. Mouse-aware TUIs can own their own
  selection; use Shift while dragging to request a normal terminal selection.
- **Allow terminal applications to copy text** is enabled by default. It accepts bounded UTF-8 OSC 52
  writes after a recent mouse selection or copy gesture in the active terminal, including writes
  emitted before mouse release. This lets TUI copy operations work when ordinary copy-on-selection
  is disabled. Turn it off to reject application clipboard writes. Background/inactive terminals,
  unsolicited writes and clipboard queries are rejected; clipboard read access is never granted.

Only a terminal application that emits the clipboard protocol can copy its own selection through
OSC 52. A multiplexer or intermediate SSH layer may require its own clipboard configuration.
The application clipboard setting cannot enable an unsupported protocol in a remote program.
