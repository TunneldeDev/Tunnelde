// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import type { ResolvedLanguage } from "@/lib/appearance";
import en from "@/i18n/en-US.json";
import zh from "@/i18n/zh-CN.json";

export const resources = {
  "en-US": { translation: en },
  "zh-CN": { translation: zh },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: "en-US",
  fallbackLng: "en-US",
  supportedLngs: ["en-US", "zh-CN"],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function setLanguage(language: ResolvedLanguage): void {
  if (i18n.resolvedLanguage !== language) {
    void i18n.changeLanguage(language);
  }
}

export default i18n;
