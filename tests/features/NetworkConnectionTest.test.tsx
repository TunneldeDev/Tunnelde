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
  ["en-US", "HTTPS request (median)", "352 ms", "HTTPS responded · slow request"],
  ["zh-CN", "HTTPS 请求耗时（中位数）", "352 毫秒", "HTTPS 已响应 · 请求较慢"],
])(
  "uses HTTPS samples for every primary metric and classification in %s",
  async (language, label, time, status) => {
    await i18n.changeLanguage(language);
    vi.mocked(api.testProxyQuality).mockResolvedValue({
      measurement: "https",
      attempts: 3,
      successful: 3,
      samplesMs: [352, 400, 320],
      medianMs: 352,
      minMs: 320,
      maxMs: 400,
      spreadMs: 80,
      quality: "slow",
      lastError: null,
      https: { success: true, elapsedMs: 320, status: 200, error: null },
    });
    render(<NetworkConnectionTest settings={settings} />);
    fireEvent.submit(document.querySelector("form")!);
    expect((await screen.findByText(label)).parentElement?.querySelector("dd")?.textContent).toBe(
      time,
    );
    expect(screen.getByRole("status").textContent).toBe(status);
    expect(document.querySelector(".network-quality.is-slow")).not.toBeNull();
    expect(screen.getByText("3 / 3")).not.toBeNull();
    expect(screen.queryByText("TCP/tunnel setup (median)")).toBeNull();
    expect(screen.queryByText("<1 ms")).toBeNull();
    expect(screen.getByText(/200/)).not.toBeNull();
  },
);

it("does not let a failed final HTTPS sample override aggregate partial-success classification", async () => {
  vi.mocked(api.testProxyQuality).mockResolvedValue({
    measurement: "https",
    attempts: 3,
    successful: 2,
    samplesMs: [352, 352, null],
    medianMs: 352,
    minMs: 352,
    maxMs: 352,
    spreadMs: 0,
    quality: "unstable",
    lastError: { code: "validation", message: "network.timeout" },
    https: {
      success: false,
      elapsedMs: 9000,
      status: null,
      error: { code: "validation", message: "network.timeout" },
    },
  });
  render(<NetworkConnectionTest settings={settings} />);
  fireEvent.submit(document.querySelector("form")!);
  await screen.findByText("Some HTTPS requests failed");
  expect(document.querySelector(".network-quality.is-unstable")).not.toBeNull();
  expect(screen.getByText("0 ms")).not.toBeNull();
  expect(screen.getByText("2 / 3")).not.toBeNull();
  expect(screen.getByText("Failed")).not.toBeNull();
  expect(screen.queryByText(/TCP proxy tunnel works/)).toBeNull();
});

it("never shows failed HTTPS requests as zero-millisecond successful connections", async () => {
  vi.mocked(api.testProxyQuality).mockResolvedValue({
    measurement: "https",
    attempts: 3,
    successful: 0,
    samplesMs: [null, null, null],
    medianMs: null,
    minMs: null,
    maxMs: null,
    spreadMs: null,
    quality: "unreachable",
    lastError: { code: "validation", message: "network.httpsRequestFailed" },
  });
  render(<NetworkConnectionTest settings={settings} />);
  fireEvent.submit(document.querySelector("form")!);
  await screen.findByText("HTTPS connection failed");
  expect(screen.getByText("0 / 3")).not.toBeNull();
  expect(screen.getAllByText("—")).toHaveLength(4);
  expect(screen.queryByText("<1 ms")).toBeNull();
  expect(
    screen.getByText("HTTPS request failed. Check the selected route, proxy and destination."),
  ).not.toBeNull();
  expect(screen.queryByText(/TCP proxy tunnel works/)).toBeNull();
});

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
