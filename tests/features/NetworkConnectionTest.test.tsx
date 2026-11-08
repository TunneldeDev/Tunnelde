import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n/i18n";
import { NetworkConnectionTest } from "@/features/settings/NetworkConnectionTest";
import { api } from "@/lib/api/ipc";
vi.mock("@/lib/api/ipc", () => ({ api: { testProxyQuality: vi.fn() } }));
vi.mock("@/lib/session/viewState", () => ({ useBackgroundGuard: vi.fn() }));
const settings = {
  defaultProxy: "direct",
  features: { marketplace: "market-proxy" },
  profiles: [
    {
      id: "market-proxy",
      name: "Market proxy",
      protocol: "http" as const,
      host: "127.0.0.1",
      port: 7890,
      username: "",
    },
  ],
};
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
});

it("tests the feature-specific marketplace route and clearly reports TCP success with TLS failure", async () => {
  vi.mocked(api.testProxyQuality).mockResolvedValue({
    attempts: 3,
    successful: 3,
    samplesMs: [1, 2, 3],
    medianMs: 2,
    minMs: 1,
    maxMs: 3,
    spreadMs: 2,
    quality: "fast",
    lastError: null,
    https: {
      success: false,
      elapsedMs: 20,
      status: null,
      error: { code: "validation", message: "network.httpsFailed" },
    },
  });
  render(<NetworkConnectionTest settings={settings} />);
  fireEvent.submit(screen.getByRole("button", { name: "Test connection" }).closest("form")!);
  await waitFor(() =>
    expect(api.testProxyQuality).toHaveBeenCalledWith("market-proxy", "github.com", 443),
  );
  await waitFor(() =>
    expect(document.querySelector(".network-quality.is-unreachable")).not.toBeNull(),
  );
  expect(
    screen.getAllByText(/TCP proxy tunnel works, but HTTPS\/TLS failed/).length,
  ).toBeGreaterThan(0);
});
