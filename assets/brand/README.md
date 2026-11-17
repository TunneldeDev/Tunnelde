# Brand assets

All committed brand images live here. Different sizes and formats serve different
consumers; they are not separate sources of artwork.

| Asset                                         | Consumer                                   |
| --------------------------------------------- | ------------------------------------------ |
| `tunnelde-mark-1024.png`                      | Canonical transparent master artwork       |
| `mark-256.png`                                | Renderer logo and native 256px bundle icon |
| `favicon.png`                                 | Vite-processed HTML favicon                |
| `32x32.png`                                   | Native bundle icon and Windows/Linux tray  |
| `128x128.png`, `icon.ico`, `icon.icns`        | Platform bundle/installer icons            |
| `trayTemplate.png`, `trayTemplate@2x.png`     | macOS monochrome tray variants             |
| `installerHeader.bmp`, `installerSidebar.bmp` | Windows NSIS artwork                       |

Renderer components import `src/lib/brand.ts`; Vite emits only their referenced,
hashed assets. Rust embeds the tray image and Tauri references bundle assets
directly.

`scripts/brand/matte_icon.py --source <raw-white-background-artwork>` generates
these files. It requires Pillow and NumPy; previews go to ignored `.tmp/brand`.
Run `node scripts/brand/verify-brand.mjs` to verify committed image formats and
dimensions without extra dependencies.
