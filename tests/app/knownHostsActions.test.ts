import "@/i18n/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { startPanelActions } from "@/app/panelActions";
import {
  createKnownHostsSource,
  installKnownHostsSource,
} from "@/features/settings/knownHosts/source";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelActionJob } from "@/lib/panels/windowProtocol";
const mock = vi.hoisted(() => ({
  execute: undefined as unknown as (job: PanelActionJob) => Promise<unknown>,
}));
vi.mock("@/lib/panels/windowActions", () => ({
  startWindowActions: (_: unknown, execute: typeof mock.execute) => {
    mock.execute = execute;
    return { dispose: () => {} };
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
it("dispatches known-host actions to the singleton and translates native stale-consent failures", async () => {
  const source = createKnownHostsSource();
  cleanups.push(source.dispose, installKnownHostsSource(source));
  const refresh = vi.spyOn(source, "refresh").mockResolvedValue(undefined),
    forget = vi.spyOn(source, "forget").mockResolvedValue(undefined);
  cleanups.push(startPanelActions({ windowId: "main" } as PanelWindowClient, vi.fn()));
  const entry = {
    host: "qa",
    port: 22,
    algorithm: "ed25519",
    fingerprint: "SHA256:confirmed",
    updatedAt: 1,
  };
  const request = (request: PanelActionJob["request"]) =>
    mock.execute({
      id: "job",
      lease: { panelId: "knownHosts", windowId: "satellite", generation: 4 },
      request,
    });
  await request({ kind: "refreshKnownHosts" });
  await request({ kind: "forgetKnownHost", entry });
  expect(refresh).toHaveBeenCalledOnce();
  expect(forget).toHaveBeenCalledExactlyOnceWith(entry);
  forget.mockRejectedValueOnce({ code: "validation", message: "settings.knownHostsChanged" });
  await expect(request({ kind: "forgetKnownHost", entry })).rejects.toThrow("trusted key changed");
});
