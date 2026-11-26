import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { ReleaseHistoryPanel } from "@/features/settings/components/ReleaseHistoryPanel";
import type { ReleaseHistory } from "@/lib/api/types";
const history: ReleaseHistory = {
  currentVersion: "2.0.0",
  version: "2.0.0",
  complete: true,
  reason: null,
  entries: [{ version: "1.0.0", notes: "Older release", publishedAt: null }],
};
it("opens history without an available update and retries a failed read", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(history);
  render(
    <ReleaseHistoryPanel channel="stable" load={load} renderMarkdown={(text) => <p>{text}</p>} />,
  );
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Release history" }));
  await screen.findByText("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("v1.0.0");
  expect(load).toHaveBeenCalledTimes(2);
});
it("discards a late response from a previously selected channel", async () => {
  let finish!: (data: ReleaseHistory) => void;
  const load = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ ...history, entries: [] });
  const props = { load, renderMarkdown: (text: string) => <p>{text}</p> };
  const view = render(<ReleaseHistoryPanel channel="stable" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Release history" }));
  view.rerender(<ReleaseHistoryPanel channel="beta" {...props} />);
  await screen.findByText("No releases in this channel.");
  await act(async () => finish(history));
  expect(screen.queryByText("v1.0.0")).toBeNull();
});

it("renders Markdown only when a release is expanded", async () => {
  const renderMarkdown = vi.fn((text: string) => <p>{text}</p>);
  render(
    <ReleaseHistoryPanel
      channel="stable"
      load={async () => history}
      renderMarkdown={renderMarkdown}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Release history" }));
  const summary = await screen.findByText("v1.0.0");
  expect(renderMarkdown).not.toHaveBeenCalled();
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect(await screen.findByText("Older release")).toBeTruthy();
});
