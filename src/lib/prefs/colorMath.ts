export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Hsv {
  h: number;
  s: number;
  v: number;
}
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function normalizeHex(value: string): string | null {
  const input = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(input))
    return `#${[...input]
      .map((digit) => digit + digit)
      .join("")
      .toLowerCase()}`;
  return /^[\da-f]{6}$/i.test(input) ? `#${input.toLowerCase()}` : null;
}
export function hexToRgb(value: string): Rgb {
  const hex = normalizeHex(value) ?? "#000000";
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((value) =>
      Math.round(clamp(value, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const red = r / 255,
    green = g / 255,
    blue = b / 255;
  const max = Math.max(red, green, blue),
    min = Math.min(red, green, blue),
    delta = max - min;
  let h = 0;
  if (delta) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = (((h % 360) + 360) % 360) / 60;
  const saturation = clamp(s),
    brightness = clamp(v);
  const chroma = brightness * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = brightness - chroma;
  const channels =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return {
    r: Math.round((channels[0]! + m) * 255),
    g: Math.round((channels[1]! + m) * 255),
    b: Math.round((channels[2]! + m) * 255),
  };
}
