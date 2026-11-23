import { reportError } from "@/lib/diagnostics";
import { selectedFontsReady } from "@/lib/fonts/runtime";

/** Load the selected fonts without relying on animation frames in a hidden webview. */
export async function loadStartupFonts(): Promise<void> {
  if (!document.fonts?.load) return;
  await selectedFontsReady();
  const ui = getComputedStyle(document.body).fontFamily.split(",")[0]?.trim() ?? "";
  const mono =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--td-mono")
      .split(",")[0]
      ?.trim() ?? "";
  const fonts = [
    ...[400, 500, 600].map((weight) => ({ family: ui, weight })),
    ...[400, 500].map((weight) => ({ family: mono, weight })),
  ];
  const results = await Promise.allSettled(
    fonts
      .filter(({ family }) => family)
      .map(({ family, weight }) =>
        document.fonts.load(`${weight} 14px ${family}`, "Tunnelde 0123456789"),
      ),
  );
  if (results.some((result) => result.status === "rejected")) {
    reportError("startup", "loadFonts", new Error("fonts.loadFailed"), "warn");
  }
}
