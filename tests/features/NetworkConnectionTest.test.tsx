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
  expect(
    screen.getByText("HTTPS probe elapsed time").parentElement?.querySelector("dd")?.textContent,
  ).toBe("20 ms");
});

it.each([
  ["en-US", "TCP/tunnel setup (median)", "HTTPS probe elapsed time", "<1 ms", "1,658 ms"],
  ["zh-CN", "TCP/代理通道建立（中位数）", "HTTPS 探测总耗时", "<1 毫秒", "1,658 毫秒"],
])(
  "distinguishes sub-millisecond tunnel setup from HTTPS elapsed time in %s",
  async (language, tcpLabel, httpsLabel, tcpTime, httpsTime) => {
    await i18n.changeLanguage(language);
    vi.mocked(api.testProxyQuality).mockResolvedValue({
      attempts: 3,
      successful: 3,
      samplesMs: [1, 0, 0],
      medianMs: 0,
      minMs: 0,
      maxMs: 1,
      spreadMs: 1,
      quality: "fast",
      lastError: null,
      https: { success: true, elapsedMs: 1658, status: 200, error: null },
    });
    render(<NetworkConnectionTest settings={settings} />);
    fireEvent.submit(document.querySelector("form")!);
    expect(
      (await screen.findByText(tcpLabel)).parentElement?.querySelector("dd")?.textContent,
    ).toBe(tcpTime);
    expect(screen.getByText(httpsLabel).parentElement?.querySelector("dd")?.textContent).toBe(
      httpsTime,
    );
    expect(screen.getByText("3 / 3")).not.toBeNull();
    expect(screen.getByText(/HTTP 200/)).not.toBeNull();
    // The classification describes connection setup, never end-to-end RTT.
    expect(screen.queryByText(/low latency|延迟较低/)).toBeNull();
    expect(screen.getByText(/transparent proxies|透明代理/)).not.toBeNull();
  },
);

it("does not invent an HTTPS measurement for TCP-only endpoints", async () => {
  vi.mocked(api.testProxyQuality).mockResolvedValue({
    attempts: 3,
    successful: 3,
    samplesMs: [10, 20, 30],
    medianMs: 20,
    minMs: 10,
    maxMs: 30,
    spreadMs: 20,
    quality: "fast",
    lastError: null,
  });
  render(<NetworkConnectionTest settings={settings} />);
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "22" } });
  fireEvent.submit(document.querySelector("form")!);
  await screen.findByText("TCP/tunnel setup (median)");
  expect(api.testProxyQuality).toHaveBeenCalledWith("market-proxy", "github.com", 22);
  expect(screen.queryByText("HTTPS probe elapsed time")).toBeNull();
});
