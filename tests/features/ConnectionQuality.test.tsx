import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { ConnectionQuality } from "@/features/connect/ConnectionQuality";
import type { ConnectionQuality as Quality } from "@/lib/api/types";

const mock = vi.hoisted(() => ({ sshTestConnection: vi.fn(), sshCancelTest: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: mock }));
const onTesting = vi.fn();
const onKeyError = vi.fn();
const credentials = {};
const normal: Quality = {
  attempts: 3,
  successful: 3,
  samplesMs: [36, 40, 32],
  medianMs: 36,
  spreadMs: 8,
  quality: "fast",
  lastError: null,
};
const props = { hostId: "target", credentials, enabled: true, onTesting, onKeyError };

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mock.sshTestConnection.mockResolvedValue(normal);
  mock.sshCancelTest.mockResolvedValue(undefined);
});

it("requires trust, starts only when requested and shows setup metrics instead of bandwidth claims", async () => {
  const { rerender } = render(<ConnectionQuality {...props} enabled={false} />);
  expect(
    (screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(mock.sshTestConnection).not.toHaveBeenCalled();
  rerender(<ConnectionQuality {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Fast connection setup");
  expect(mock.sshTestConnection).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    "target",
    credentials,
  );
  expect(screen.getByText("36 ms", { selector: "dd" })).toBeTruthy();
  expect(screen.getByText("8 ms")).toBeTruthy();
  expect(screen.getByText("3 / 3")).toBeTruthy();
  expect(onTesting.mock.calls).toEqual([[true], [false]]);
  expect(screen.getByText(/not a bandwidth or packet-loss test/)).toBeTruthy();
});

it("deduplicates requests, allows cancellation and translates the cancellation inline", async () => {
  let reject!: (error: unknown) => void;
  mock.sshTestConnection.mockReturnValue(
    new Promise<Quality>((_, failed) => {
      reject = failed;
    }),
  );
  render(<ConnectionQuality {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(screen.getByRole("status").textContent).toContain("Testing up to 3");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mock.sshCancelTest).toHaveBeenCalledExactlyOnceWith(
    mock.sshTestConnection.mock.calls[0]![0],
  );
  await act(async () => reject({ code: "ssh", message: "ssh.testCancelled" }));
  await screen.findByText("Connection test cancelled");
  expect(mock.sshTestConnection).toHaveBeenCalledOnce();
  expect(
    (screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("cancels in-flight work on unmount and ignores its late result", async () => {
  let resolve!: (result: Quality) => void;
  mock.sshTestConnection.mockReturnValue(
    new Promise<Quality>((done) => {
      resolve = done;
    }),
  );
  const { unmount } = render(<ConnectionQuality {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  unmount();
  expect(mock.sshCancelTest).toHaveBeenCalledExactlyOnceWith(
    mock.sshTestConnection.mock.calls[0]![0],
  );
  await act(async () => resolve(normal));
  expect(onTesting.mock.calls).toEqual([[true], [false]]);
});

it("invalidates a result when route credentials change and excludes the previous host's late result", async () => {
  let resolve!: (result: Quality) => void;
  mock.sshTestConnection.mockReturnValueOnce(
    new Promise<Quality>((done) => {
      resolve = done;
    }),
  );
  const { rerender } = render(<ConnectionQuality {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  rerender(<ConnectionQuality {...props} hostId="other" />);
  await act(async () => resolve(normal));
  expect(screen.queryByText("Fast connection setup")).toBeNull();
  expect(mock.sshCancelTest).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Fast connection setup");
  rerender(
    <ConnectionQuality {...props} hostId="other" credentials={{ jump: { password: "new" } }} />,
  );
  expect(screen.queryByText("Fast connection setup")).toBeNull();
});

it("shows failed samples as failures and requests fresh host-key verification after a key error", async () => {
  mock.sshTestConnection.mockResolvedValueOnce({
    ...normal,
    successful: 2,
    samplesMs: [36, null, 32],
    quality: "unstable",
    lastError: "ssh.timeout",
  });
  render(<ConnectionQuality {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
  await screen.findByText("Some attempts failed");
  expect(screen.getByText("2 / 3")).toBeTruthy();
  expect(screen.getByText("Failed")).toBeTruthy();
  expect(screen.getByText("Connection timed out")).toBeTruthy();
  mock.sshTestConnection.mockRejectedValueOnce({ code: "ssh", message: "ssh.hostKeyChanged" });
  fireEvent.click(screen.getByRole("button", { name: "Test again" }));
  await waitFor(() => expect(onKeyError).toHaveBeenCalledOnce());
  expect(screen.getByText("The host key changed")).toBeTruthy();
  expect(screen.queryByText("Some attempts failed")).toBeNull();
});
