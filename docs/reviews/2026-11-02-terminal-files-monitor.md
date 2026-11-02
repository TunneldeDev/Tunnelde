# Terminal, file loading and monitoring review

Scope: slow remote folder loading, terminal selection copying, live command history,
terminal preview clipping/scrolling, clipped tab labels and interactive remote metrics.
AI plugin connection/session discovery remains deferred separately.

- File loading status now uses the fixed footer instead of inserting a list row.
- Terminal fitting measures a padding-free inner surface shared by the preview and live terminal.
  The preview retains its complete sample independently of the SSH scrollback preference.
- Native selection copying captures text before redraw can clear it. Mouse-aware applications
  can write OSC 52 clipboard text after a recent user selection/copy gesture in an active
  terminal with copy-on-select enabled. Queries, unsolicited writes and invalid payloads are rejected.
- History recording notifies mounted views after persistence. Notifications are host-scoped;
  rerunning entries updates recency only when recording is enabled.
- CPU, memory, receive/send and disk read/write graphs share the bounded session sample store
  and polling loop. Samples use actual timestamps; missing disk samples break the curve.
  Scales, dashed grids, hover values and keyboard inspection use the same chart component.
- Linux disk sampling reads existing `/sys/block` counters, skips stacked and synthetic devices,
  and computes rates from matching device deltas. First/missing samples are unavailable.

Validation:

- Frontend: TypeScript, ESLint, production build and 667 tests passed.
- Native: Clippy with warnings denied and 165 tests passed, including disk deltas,
  device reset/removal, missing counters and CPU guest accounting.
- Isolated Tauri/WebView2 runtime: nine checks passed using real xterm, actual production CSS
  and controlled delayed file responses. Large-font preview scrolling, complete row geometry,
  immediate history updates, the Pi OSC 52 protocol, four chart tooltips, tab glyph ink bounds,
  and scrolled SFTP refresh geometry were verified. Pi's binary itself was not launched.
- The production monitor shell script ran twice over SSH on the authorized test server using
  read-only commands; disk counters for `vda` were returned. No remote files or services changed.
- The user's installed application and its data were not used by the isolated runtime fixture.
