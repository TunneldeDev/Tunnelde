# Third-party notices

Tunnelde is licensed under `GPL-3.0-only`. The dependencies below are compatible with that license;
their notices are reproduced or referenced as required.

## Runtime libraries

| Component                                               | License                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| Tauri, tauri-plugin-*                                   | MIT OR Apache-2.0                                      |
| React, React DOM                                        | MIT                                                    |
| i18next, react-i18next                                  | MIT                                                    |
| zustand                                                 | MIT                                                    |
| clsx                                                    | MIT                                                    |
| PDF.js (pdfjs-dist), bundled CMaps and decoder wrappers | Apache-2.0; Adobe BSD-style CMap notice                |
| PDF.js Foxit standard fonts                             | BSD-3-Clause                                           |
| PDF.js Liberation fonts                                 | GPL-2.0 with font exception                            |
| PDF.js OpenJPEG, JBIG2 and QCMS decoders                | BSD-style / Apache-2.0 / MIT; bundled notices          |
| lucide-react                                            | ISC                                                    |
| rusqlite (bundled SQLite)                               | MIT; SQLite is public domain                           |
| russh                                                   | MIT                                                    |
| russh-sftp                                              | MIT                                                    |
| ring                                                    | ISC-style license                                      |
| xterm.js, @xterm/addon-fit, @xterm/addon-webgl          | MIT                                                    |
| arboard (native clipboard)                              | MIT OR Apache-2.0                                      |
| base64                                                  | MIT OR Apache-2.0                                      |
| keyring                                                 | MIT OR Apache-2.0                                      |
| Tokio                                                   | MIT                                                    |
| Serde, serde_json                                       | MIT OR Apache-2.0                                      |
| tracing, tracing-subscriber, tracing-appender           | MIT                                                    |
| thiserror                                               | MIT OR Apache-2.0                                      |
| uuid                                                    | Apache-2.0 OR MIT                                      |
| chrono                                                  | MIT OR Apache-2.0                                      |
| sysinfo                                                 | MIT                                                    |
| Windows WebView2 runtime                                | Microsoft software license, redistributed by Microsoft |

## Fonts

| Font           | License                   |
| -------------- | ------------------------- |
| IBM Plex Sans  | SIL Open Font License 1.1 |
| IBM Plex Mono  | SIL Open Font License 1.1 |
| Fira Code      | SIL Open Font License 1.1 |
| JetBrains Mono | SIL Open Font License 1.1 |

The SIL Open Font License permits bundling and redistribution with the application.

## Optional runtimes

Node.js is needed only for Node-based plugins. It is not bundled, and the user must explicitly
approve the runtime before a system Node can be used. Declarative themes, file icons and
preview packages require no Node runtime. PDF.js runs locally in the WebView and a bundled worker.
Its bundled resource licenses can be expanded in the PDF preview.

## Build tooling

Vite, TypeScript, ESLint, Prettier, Vitest and Tailwind-free CSS tooling are development-only
dependencies and are not part of the distributed binaries.

## Updating this file

Add an entry when a dependency is introduced, removed or relicensed. Full license texts ship with
each package in the dependency cache and are available on request.
