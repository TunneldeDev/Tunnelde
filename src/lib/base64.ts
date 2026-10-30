// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes terminal input so arbitrary bytes survive the JSON IPC layer. */
export function encodeBase64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeBase64Text(value: string): string {
  return decoder.decode(decodeBase64(value));
}
