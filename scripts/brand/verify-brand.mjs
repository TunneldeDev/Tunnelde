#!/usr/bin/env node
/**
 * Verify the committed brand assets without extra dependencies.
 * Checks PNG dimensions, ICO frame list and ICNS container integrity.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(path);
const fail = (message) => {
  console.error(`[brand:verify] FAIL ${message}`);
  process.exitCode = 1;
};

function pngInfo(path) {
  const bytes = read(path);
  if (bytes.readUInt32BE(0) !== 0x89504e47) return fail(`${path}: bad PNG signature`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  return { width, height, bitDepth, colorType };
}

function icoInfo(path) {
  const bytes = read(path);
  const reserved = bytes.readUInt16LE(0);
  const type = bytes.readUInt16LE(2);
  const count = bytes.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) return fail(`${path}: not an ICO`);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    if (width !== height) fail(`${path}: non-square frame ${width}x${height}`);
    sizes.push(width);
  }
  return sizes;
}

function icnsInfo(path) {
  const bytes = read(path);
  if (bytes.subarray(0, 4).toString("ascii") !== "icns") return fail(`${path}: not ICNS`);
  const length = bytes.readUInt32BE(4);
  if (length !== bytes.length) fail(`${path}: length ${length} != file ${bytes.length}`);
  const types = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > bytes.length) {
      fail(`${path}: bad entry ${type} size ${size}`);
      break;
    }
    types.push(type);
    offset += size;
  }
  return types;
}

const expected = {
  "assets/brand/tunnelde-mark-1024.png": { width: 1024, height: 1024 },
  "assets/brand/32x32.png": { width: 32, height: 32 },
  "assets/brand/128x128.png": { width: 128, height: 128 },
  "assets/brand/mark-256.png": { width: 256, height: 256 },
  "assets/brand/favicon.png": { width: 64, height: 64 },
  "assets/brand/trayTemplate.png": { width: 16, height: 16 },
  "assets/brand/trayTemplate@2x.png": { width: 32, height: 32 },
};

for (const [relative, size] of Object.entries(expected)) {
  const path = `${root}${relative}`;
  try {
    const info = pngInfo(path);
    if (info.width !== size.width || info.height !== size.height) {
      fail(`${relative}: ${info.width}x${info.height}, expected ${size.width}x${size.height}`);
    }
    if (info.colorType !== 6)
      fail(`${relative}: expected RGBA (color type 6), got ${info.colorType}`);
    console.log(`[brand:verify] png ${relative} ${info.width}x${info.height} rgba`);
  } catch (error) {
    fail(`${relative}: ${error.message}`);
  }
}

try {
  const sizes = icoInfo(`${root}assets/brand/icon.ico`);
  for (const required of [16, 32, 48, 256]) {
    if (!sizes.includes(required)) fail(`icon.ico missing ${required}px frame`);
  }
  console.log(`[brand:verify] ico ${sizes.join("/")}`);
} catch (error) {
  fail(`icon.ico: ${error.message}`);
}

try {
  const types = icnsInfo(`${root}assets/brand/icon.icns`);
  for (const required of ["ic07", "ic08", "ic10"]) {
    if (!types.includes(required)) fail(`icon.icns missing ${required}`);
  }
  console.log(`[brand:verify] icns ${types.join("/")}`);
} catch (error) {
  fail(`icon.icns: ${error.message}`);
}

for (const relative of ["assets/brand/installerSidebar.bmp", "assets/brand/installerHeader.bmp"]) {
  try {
    const bytes = read(`${root}${relative}`);
    if (bytes.subarray(0, 2).toString("ascii") !== "BM") fail(`${relative}: not BMP`);
    const bits = bytes.readUInt16LE(28);
    if (bits !== 24) fail(`${relative}: expected 24-bit BMP, got ${bits}`);
    console.log(
      `[brand:verify] bmp ${relative} 24-bit ${bytes.readInt32LE(18)}x${Math.abs(bytes.readInt32LE(22))}`,
    );
  } catch (error) {
    fail(`${relative}: ${error.message}`);
  }
}

console.log(`[brand:verify] ${process.exitCode ? "completed with errors" : "all checks passed"}`);
