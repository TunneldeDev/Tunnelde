import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "@/lib/session/clipboard";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";
vi.mock("@/store/toasts", () => ({ toast: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => false }));
afterEach(() => vi.unstubAllGlobals());
it("reports an unavailable browser clipboard without throwing or misreporting success", async () => {
  vi.stubGlobal("navigator", {});
  copyText("output");
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(i18n.t("menu.copyFailed"), "error"));
});
