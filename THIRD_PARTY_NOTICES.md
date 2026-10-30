# Third-party notices

Tunnelde is licensed under `GPL-3.0-only`. The dependencies below are compatible with that license;
their notices are reproduced or referenced as required.

## Runtime libraries

| Component                                     | License                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| Tauri, tauri-plugin-*                         | MIT OR Apache-2.0                                      |
| React, React DOM                              | MIT                                                    |
| i18next, react-i18next                        | MIT                                                    |
| zustand                                       | MIT                                                    |
| clsx                                          | MIT                                                    |
| lucide-react                                  | ISC                                                    |
| rusqlite (bundled SQLite)                     | MIT; SQLite is public domain                           |
| russh                                         | MIT                                                    |
| ring                                          | ISC-style license                                      |
| xterm.js, @xterm/addon-fit                    | MIT                                                    |
| base64                                        | MIT OR Apache-2.0                                      |
| Tokio                                         | MIT                                                    |
| Serde, serde_json                             | MIT OR Apache-2.0                                      |
| tracing, tracing-subscriber, tracing-appender | MIT                                                    |
| thiserror                                     | MIT OR Apache-2.0                                      |
| uuid                                          | Apache-2.0 OR MIT                                      |
| chrono                                        | MIT OR Apache-2.0                                      |
| sysinfo                                       | MIT                                                    |
| Windows WebView2 runtime                      | Microsoft software license, redistributed by Microsoft |

## Fonts

| Font          | License                   |
| ------------- | ------------------------- |
| IBM Plex Sans | SIL Open Font License 1.1 |
| IBM Plex Mono | SIL Open Font License 1.1 |

The SIL Open Font License permits bundling and redistribution with the application.

## Build tooling

Vite, TypeScript, ESLint, Prettier, Vitest and Tailwind-free CSS tooling are development-only
dependencies and are not part of the distributed binaries.

## Updating this file

Add an entry when a dependency is introduced, removed or relicensed. Full license texts ship with
each package in the dependency cache and are available on request.
