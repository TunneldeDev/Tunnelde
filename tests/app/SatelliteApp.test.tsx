import "@/i18n/i18n";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SatelliteApp } from "@/app/SatelliteApp";
const mock = vi.hoisted(() => ({ initialize: vi.fn(), bootstrap: vi.fn() }));
vi.mock("@/lib/panels/windowClient", () => ({ initializePanelWindow: mock.initialize }));
vi.mock("@/app/bootstrap", () => ({ bootstrap: mock.bootstrap }));
beforeEach(() => {
  mock.initialize.mockReset();
  mock.bootstrap.mockReset();
});
afterEach(cleanup);
it("does not start resource bootstrap or acknowledge a view before its adapter is attached", async () => {
  const client = {
    dispose: vi.fn(),
    onClose: vi.fn().mockResolvedValue(() => {}),
    control: vi.fn(),
  };
  mock.initialize.mockResolvedValue(client);
  const view = render(<SatelliteApp />);
  await waitFor(() => expect(client.onClose).toHaveBeenCalledTimes(1));
  expect(mock.bootstrap).not.toHaveBeenCalled();
  expect(client.control).not.toHaveBeenCalled();
  view.unmount();
  expect(client.dispose).toHaveBeenCalledTimes(1);
});
it("disposes an initialization that finishes after the document unmounts", async () => {
  let done!: (client: unknown) => void;
  mock.initialize.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const view = render(<SatelliteApp />);
  view.unmount();
  const client = { dispose: vi.fn(), onClose: vi.fn() };
  await act(async () => {
    done(client);
  });
  expect(client.dispose).toHaveBeenCalledTimes(1);
  expect(client.onClose).not.toHaveBeenCalled();
});
it("reports a denied native initialization rather than falling back to main bootstrap", async () => {
  mock.initialize.mockRejectedValue(new Error("unregistered window"));
  render(<SatelliteApp />);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not initialize");
  expect(mock.bootstrap).not.toHaveBeenCalled();
});
