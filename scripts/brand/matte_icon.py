#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
"""Tunnelde brand asset pipeline.

Takes the raw artwork (white background), builds a clean alpha matte, trims it,
and emits every icon format the app, installers and storefronts need.

Usage:
    python scripts/brand/matte_icon.py [--source .tmp/icon.png]

Requires Pillow and numpy.
"""

from __future__ import annotations

import argparse
import io
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
NAVY = (14, 21, 48)
INK = (7, 11, 20)
BLUE = (76, 141, 255)
CYAN = (53, 224, 255)

# Sizes we render everywhere. ICO gets the odd Windows sizes too.
PNG_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024)
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)


def log(message: str) -> None:
    print(f"[brand] {message}")


def load_source(path: Path) -> Image.Image:
    image = Image.open(path)
    if image.mode != "RGB":
        image = image.convert("RGB")
    log(f"source {path} {image.size[0]}x{image.size[1]}")
    return image


def build_matte(source: Image.Image) -> Image.Image:
    """Remove the near-white background and decontaminate the silhouette edge."""
    work = source.copy()
    # A colour that does not exist in the artwork. Flood fill is seeded from the
    # four edges, so interior whites (there are none today) stay untouched.
    marker = (255, 0, 255)
    ImageDraw.floodfill(work, (0, 0), marker, thresh=10)
    ImageDraw.floodfill(work, (work.width - 1, 0), marker, thresh=10)
    ImageDraw.floodfill(work, (0, work.height - 1), marker, thresh=10)
    ImageDraw.floodfill(work, (work.width - 1, work.height - 1), marker, thresh=10)

    marked = np.asarray(work)
    background = (
        (marked[:, :, 0] == marker[0])
        & (marked[:, :, 1] == marker[1])
        & (marked[:, :, 2] == marker[2])
    )
    if background.mean() < 0.05:
        raise RuntimeError("background flood fill failed; refusing to write broken icons")

    # Dilate the background mask so we can find the antialiased rim.
    grown = background.copy()
    for _ in range(5):
        nxt = grown.copy()
        nxt[1:, :] |= grown[:-1, :]
        nxt[:-1, :] |= grown[1:, :]
        nxt[:, 1:] |= grown[:, :-1]
        nxt[:, :-1] |= grown[:, 1:]
        grown = nxt
    rim = (~background) & grown

    rgb = np.asarray(source).astype(np.float32)
    navy = np.asarray(NAVY, dtype=np.float32)

    # The silhouette is uniform navy, so per-channel alpha can be recovered from
    # the white blend: c = a*navy + (1-a)*255.
    channel_alpha = (255.0 - rgb) / (255.0 - navy)
    alpha = np.clip(channel_alpha, 0.0, 1.0).mean(axis=2)
    alpha[~rim] = 1.0
    alpha[background] = 0.0
    alpha[alpha < 0.03] = 0.0
    alpha[alpha > 0.985] = 1.0

    out_rgb = rgb.copy()
    out_rgb[rim] = navy
    rgba = np.dstack([out_rgb, alpha * 255.0]).astype(np.uint8)
    matte = Image.fromarray(rgba, "RGBA")

    # Trim to the visible silhouette, then centre on a square with 4% breathing room.
    bbox = matte.getchannel("A").point(lambda v: 255 if v > 6 else 0).getbbox()
    if not bbox:
        raise RuntimeError("matte is empty")
    matte = matte.crop(bbox)
    side = max(matte.size)
    padding = int(round(side * 0.04))
    canvas_side = side + padding * 2
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.paste(matte, ((canvas_side - matte.width) // 2, (canvas_side - matte.height) // 2))
    canvas = canvas.resize((1024, 1024), Image.Resampling.LANCZOS)
    log(f"matte bbox {bbox} -> master 1024 (padding {padding}px)")
    return canvas


def resize(master: Image.Image, size: int) -> Image.Image:
    image = master.resize((size, size), Image.Resampling.LANCZOS)
    if size <= 48:
        # A tiny amount of sharpening keeps the terminal glyph readable at 16-32px.
        image = image.filter(ImageFilter.UnsharpMask(radius=0.6, percent=55, threshold=0))
    return image


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def write_ico(images: dict[int, Image.Image], path: Path) -> None:
    """Write a multi-frame ICO with 32-bit DIB frames and a PNG 256px frame."""
    frames: list[tuple[int, bytes]] = []
    for size in ICO_SIZES:
        image = images[size]
        if size >= 256:
            frames.append((size, png_bytes(image)))
            continue
        width, height = image.size
        pixels = np.asarray(image)
        xor = bytearray()
        for y in range(height - 1, -1, -1):  # DIB rows are bottom-up
            row = pixels[y]
            for r, g, b, a in row:
                xor.extend((int(b), int(g), int(r), int(a)))
        mask_row = ((width + 31) // 32) * 4
        mask = bytes(mask_row * height)
        header = struct.pack(
            "<IiiHHIIiiII",
            40,
            width,
            height * 2,
            1,
            32,
            0,
            len(xor) + len(mask),
            0,
            0,
            0,
            0,
        )
        frames.append((size, header + bytes(xor) + mask))

    offset = 6 + 16 * len(frames)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    payload = bytearray()
    for size, data in frames:
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                0 if size >= 256 else size,
                0 if size >= 256 else size,
                0,
                0,
                1,
                32,
                len(data),
                offset,
            )
        )
        payload.extend(data)
        offset += len(data)
    path.write_bytes(bytes(directory + payload))
    log(f"ico {path} frames={len(frames)}")


def write_icns(images: dict[int, Image.Image], path: Path) -> None:
    """ICNS container with PNG payloads (ic07+); good enough for macOS bundles."""
    type_map = {
        "icp4": 16,
        "icp5": 32,
        "icp6": 64,
        "ic07": 128,
        "ic08": 256,
        "ic09": 512,
        "ic10": 1024,
        "ic11": 32,
        "ic12": 64,
        "ic13": 256,
        "ic14": 512,
    }
    body = bytearray()
    for kind, size in type_map.items():
        payload = png_bytes(images[size])
        body.extend(kind.encode("ascii"))
        body.extend(struct.pack(">I", len(payload) + 8))
        body.extend(payload)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + bytes(body))
    log(f"icns {path} entries={len(type_map)}")


def checkerboard(size: int, cell: int = 12) -> Image.Image:
    image = Image.new("RGB", (size, size), (226, 230, 238))
    draw = ImageDraw.Draw(image)
    for y in range(0, size, cell):
        for x in range(0, size, cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill=(194, 201, 214))
    return image


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = ["seguisb.ttf", "segoeuib.ttf", "segoeui.ttf"] if bold else ["segoeui.ttf"]
    for name in names:
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def make_previews(master: Image.Image, out_dir: Path) -> None:
    """Contact sheets for manual review on dark, light and checkerboard grounds."""
    out_dir.mkdir(parents=True, exist_ok=True)
    panel = 320
    sheet = Image.new("RGB", (panel * 3, panel + 72), (245, 247, 250))
    frames = [
        (Image.new("RGB", (panel, panel), (11, 16, 32)), (232, 238, 249)),
        (Image.new("RGB", (panel, panel), (255, 255, 255)), (14, 21, 48)),
        (checkerboard(panel), (14, 21, 48)),
    ]
    draw = ImageDraw.Draw(sheet)
    label_font = load_font(15)
    icon = master.resize((220, 220), Image.Resampling.LANCZOS)
    for index, (background, _) in enumerate(frames):
        x = index * panel
        sheet.paste(background, (x, 0))
        sheet.paste(icon, (x + (panel - icon.width) // 2, (panel - icon.height) // 2), icon)
    for index, text in enumerate(("on ink", "on white", "on checkerboard")):
        draw.text((index * panel + 16, panel + 18), text, font=label_font, fill=(70, 82, 104))
    draw.text((16, panel + 42), "Tunnelde mark · 1024px matte · review edges at 100%", font=label_font, fill=(120, 132, 152))
    sheet.save(out_dir / "preview-backgrounds.png", optimize=True)

    sizes = (16, 24, 32, 48, 64, 128)
    strip = Image.new("RGB", (1000, 380), (11, 16, 32))
    draw = ImageDraw.Draw(strip)
    top_x = 24
    for size in sizes:
        rendered = resize(master, size)
        strip.paste(rendered, (top_x, 40), rendered)
        draw.text((top_x, 12), f"{size}px · 100%", font=label_font, fill=(160, 176, 200))
        top_x += 160

    bottom_x = 24
    for size in (16, 24, 32, 48):
        rendered = resize(master, size)
        zoom = rendered.resize((size * 4, size * 4), Image.Resampling.NEAREST)
        strip.paste(zoom, (bottom_x, 190), zoom)
        draw.text((bottom_x, 162), f"{size}px · 4x", font=label_font, fill=(100, 116, 140))
        bottom_x += 220
    strip.save(out_dir / "preview-sizes.png", optimize=True)
    log(f"previews {out_dir}")


def make_nsis_images(master: Image.Image, build_dir: Path, preview_dir: Path) -> None:
    build_dir.mkdir(parents=True, exist_ok=True)

    def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
        width, height = size
        image = Image.new("RGB", size)
        draw = ImageDraw.Draw(image)
        for y in range(height):
            t = y / max(1, height - 1)
            color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
            draw.line((0, y, width, y), fill=color)
        return image

    sidebar = vertical_gradient((164, 314), (18, 28, 52), (7, 11, 20))
    draw = ImageDraw.Draw(sidebar)
    # subtle blueprint lines
    for y in range(0, 314, 24):
        draw.line((0, y, 164, y), fill=(24, 37, 64))
    for x in range(0, 164, 24):
        draw.line((x, 0, x, 314), fill=(20, 31, 54))
    draw.line((20, 250, 144, 250), fill=BLUE, width=2)
    icon = master.resize((92, 92), Image.Resampling.LANCZOS)
    sidebar.paste(icon, (36, 44), icon)
    font_big = load_font(19, bold=True)
    font_small = load_font(10)
    draw.text((22, 158), "TUNNELDE", font=font_big, fill=(236, 243, 255))
    draw.text((23, 184), "SSH  ·  SFTP  ·  REMOTE OPS", font=font_small, fill=(120, 196, 255))
    draw.text((22, 274), "for Windows · macOS · Linux", font=font_small, fill=(120, 136, 162))
    sidebar.save(build_dir / "installerSidebar.bmp", format="BMP")
    sidebar.save(preview_dir / "installerSidebar.png")

    header = vertical_gradient((150, 57), (16, 26, 48), (9, 14, 27))
    hdraw = ImageDraw.Draw(header)
    hicon = master.resize((38, 38), Image.Resampling.LANCZOS)
    header.paste(hicon, (8, 10), hicon)
    hdraw.text((54, 13), "TUNNELDE", font=load_font(16, bold=True), fill=(236, 243, 255))
    hdraw.text((55, 32), "SSH WORKBENCH", font=load_font(7), fill=(120, 196, 255))
    header.save(build_dir / "installerHeader.bmp", format="BMP")
    header.save(preview_dir / "installerHeader.png")

    combo = Image.new("RGB", (384, 360), (245, 247, 250))
    combo.paste(sidebar, (18, 22))
    combo.paste(header, (206, 22))
    combo.save(preview_dir / "preview-installer.png", optimize=True)
    log("installer BMPs written")


def make_tray(master: Image.Image, resources: Path, preview_dir: Path) -> None:
    resources.mkdir(parents=True, exist_ok=True)
    colored = resize(master, 32)
    colored.save(resources / "tray-32.png", optimize=True)
    resize(master, 16).save(resources / "tray-16.png", optimize=True)

    # macOS template image: a monochrome mark that the system tints for the menu bar.
    scale = 4
    size = 32 * scale
    template = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(template)
    stroke = 3 * scale
    draw.rounded_rectangle(
        (5 * scale, 5 * scale, 27 * scale, 27 * scale),
        radius=7 * scale,
        outline=(0, 0, 0, 255),
        width=stroke,
    )
    # prompt chevron + underscore
    draw.line(
        ((11 * scale, 12 * scale), (16 * scale, 16 * scale), (11 * scale, 20 * scale)),
        fill=(0, 0, 0, 255),
        width=stroke,
        joint="curve",
    )
    draw.line((18 * scale, 21 * scale, 23 * scale, 21 * scale), fill=(0, 0, 0, 255), width=stroke)
    template_32 = template.resize((32, 32), Image.Resampling.LANCZOS)
    template_16 = template.resize((16, 16), Image.Resampling.LANCZOS)
    template_32.save(resources / "trayTemplate@2x.png", optimize=True)
    template_16.save(resources / "trayTemplate.png", optimize=True)
    template_32.save(preview_dir / "trayTemplate@2x.png", optimize=True)
    log("tray icons written")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(ROOT / ".tmp" / "icon.png"))
    args = parser.parse_args()

    source_path = Path(args.source)
    if not source_path.exists():
        raise SystemExit(f"source artwork not found: {source_path}")

    master = build_matte(load_source(source_path))

    brand_dir = ROOT / "assets" / "brand"
    build_dir = ROOT / "build"
    resources = ROOT / "resources"
    tauri_icons = ROOT / "src-tauri" / "icons"
    renderer_brand = ROOT / "public" / "brand"
    src_brand = ROOT / "src" / "assets" / "brand"
    preview_dir = ROOT / ".tmp" / "brand"
    for directory in (
        brand_dir,
        build_dir,
        build_dir / "icons",
        resources,
        resources / "icons",
        tauri_icons,
        renderer_brand,
        src_brand,
        preview_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)

    master.save(brand_dir / "tunnelde-mark-1024.png", optimize=True)
    master.save(build_dir / "icon.png", optimize=True)

    images = {size: resize(master, size) for size in PNG_SIZES}
    iconset = build_dir / "icons"
    iconset.mkdir(parents=True, exist_ok=True)
    for size in (16, 24, 32, 48, 64, 96, 128, 256, 512):
        images[size].save(iconset / f"{size}x{size}.png", optimize=True)

    # Runtime / renderer copies
    for size in (16, 32, 48, 64, 128, 256, 512):
        images[size].save(resources / "icons" / f"{size}.png", optimize=True)
    for size in (64, 256, 512):
        images[size].save(renderer_brand / f"mark-{size}.png", optimize=True)
    images[256].save(renderer_brand / "icon.png", optimize=True)
    images[64].save(renderer_brand / "favicon.png", optimize=True)
    images[512].save(src_brand / "mark-512.png", optimize=True)

    # Tauri expects these exact names.
    images[32].save(tauri_icons / "32x32.png", optimize=True)
    images[128].save(tauri_icons / "128x128.png", optimize=True)
    images[256].save(tauri_icons / "128x128@2x.png", optimize=True)
    images[512].save(tauri_icons / "icon.png", optimize=True)
    write_ico({size: images[size] for size in ICO_SIZES}, tauri_icons / "icon.ico")
    write_icns(images, tauri_icons / "icon.icns")

    # Compatibility copies for the NSIS/DMG tooling and old Electron-era scripts.
    write_ico({size: images[size] for size in ICO_SIZES}, build_dir / "icon.ico")
    write_icns(images, build_dir / "icon.icns")

    make_nsis_images(master, build_dir, preview_dir)
    make_tray(master, resources, preview_dir)
    make_previews(master, preview_dir)

    # Verification summary
    alpha = np.asarray(master.getchannel("A"))
    corners = [int(alpha[0, 0]), int(alpha[0, -1]), int(alpha[-1, 0]), int(alpha[-1, -1])]
    opaque = int((alpha > 250).sum())
    log(f"master corners={corners} opaque={opaque} bbox={master.getchannel('A').getbbox()}")
    if any(corners):
        raise SystemExit("corners are not transparent")
    log("done")


if __name__ == "__main__":
    main()
