// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { MarketEntry, PluginInfo } from "@/lib/api/types";
import { api } from "@/lib/api/ipc";
import { bytesToBase64 } from "@/lib/text/base64";

/** The catalogue lives in the repository, so adding a plugin is a reviewable commit. */
export const MARKETPLACE_INDEX_URL =
  "https://raw.githubusercontent.com/TunneldeDev/Tunnelde/main/marketplace/index.json";

const CHECKSUM = /^[0-9a-f]{64}$/i;

function isEntry(value: unknown): value is MarketEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<MarketEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.version === "string" &&
    typeof entry.url === "string" &&
    typeof entry.sha256 === "string" &&
    CHECKSUM.test(entry.sha256) &&
    entry.url.startsWith("https://")
  );
}

export async function fetchMarketplace(): Promise<MarketEntry[]> {
  const response = await fetch(MARKETPLACE_INDEX_URL, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`marketplace.index: ${response.status}`);
  }
  const payload = (await response.json()) as { plugins?: unknown };
  return Array.isArray(payload.plugins) ? payload.plugins.filter(isEntry) : [];
}

/** Downloads an archive and lets Rust verify the checksum before installing. */
export async function installMarketplaceEntry(entry: MarketEntry): Promise<PluginInfo> {
  const response = await fetch(entry.url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`marketplace.download: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return api.marketplaceInstall(entry.id, entry.sha256, bytesToBase64(bytes));
}
